/**
 * REST-транспорт: GET с bearer и cookie одновременно.
 *
 * Оба заголовка обязательны вместе (наблюдение Фазы 0): bearer авторизует вызов, cookie
 * подтверждает сессию, и без второго сервер отвечает отказом даже на свежий токен.
 *
 * Единственный известный потребитель это KDC, и путь к нему живёт в конфиге, а не у крипто:
 * крипто спрашивает ключи по идентификаторам и не знает ни базы, ни версии API.
 *
 * Ответ 401 трактуется как «токен протух», а не как «нет прав»: bearer живёт недолго, и
 * ровно один повтор после сброса кэша авторизации отделяет штатное протухание от настоящего
 * отказа. Второй 401 уже поднимается наверх: повторять дальше означало бы молотить сервер
 * входом по кругу.
 *
 * Ответ 429 это не отказ, а просьба подождать, и на GET она уважается тем же способом:
 * пауза указанной сервером длины и ровно один повтор. Единица паузы не установлена и
 * разбирается в `rateLimit`.
 */
import { AuthError, type AuthProvider } from '../auth/AuthProvider.js';
import type { Config } from '../config/types.js';
import type { Logger } from '../util/logger.js';
import { sleep } from './backoff.js';
import { RATE_LIMIT_STATUS, readRetryAfterField, resolvePauseMs } from './rateLimit.js';
import type { KdcKey, RestClient } from './types.js';

/** Отказ REST, который не является отказом авторизации */
export class RestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    readonly bodySnippet: string,
  ) {
    super(`rest: HTTP ${status}${code === undefined ? '' : ` (${code})`}: ${bodySnippet}`);
    this.name = 'RestError';
  }
}

/**
 * Сервер просит притормозить. Отдельный тип нужен затем, что просьба несёт величину паузы:
 * без неё вызывающему пришлось бы разбирать заголовок повторно и угадывать единицу второй раз.
 */
export class RateLimitError extends RestError {
  constructor(
    readonly pauseMs: number,
    code: string | undefined,
    bodySnippet: string,
  ) {
    super(RATE_LIMIT_STATUS, code, bodySnippet);
    this.name = 'RateLimitError';
  }
}

export interface HttpRestClientDeps {
  auth: AuthProvider;
  config: Config;
  logger?: Logger;
  /** Подменяется в тестах; по умолчанию глобальный fetch рантайма */
  fetchImplementation?: typeof fetch;
  /**
   * Подменяется в тестах. Пауза по лимиту частоты не может быть короче секунды по
   * построению, и живая секунда в прогоне тестов это чистая потеря времени.
   */
  sleepImplementation?: (ms: number) => Promise<void>;
}

/** Длина среза тела в ошибке: хватает на диагноз и не тянет за собой весь ответ */
const BODY_SNIPPET_LENGTH = 200;

/**
 * Длинная последовательность base64-алфавита это почти наверняка ключ, шифротекст или токен,
 * как бы ни называлось поле. Тело отказа уезжает в сообщение ошибки и оттуда в логи, поэтому
 * такие куски вырезаются до того, как ошибка построена.
 */
const SECRET_LIKE_SEQUENCE = /[A-Za-z0-9+/=_.-]{60,}/g;

function toBodySnippet(body: string): string {
  return body.replace(SECRET_LIKE_SEQUENCE, (match) => `<redacted:${match.length}>`).slice(0, BODY_SNIPPET_LENGTH);
}

/**
 * Величина паузы. Заголовок старше тела: он часть HTTP и приезжает даже тогда, когда тело
 * пустое или не в JSON, а поле в теле наблюдалось только у прикладных отказов.
 */
function extractRawPause(response: Response, body: string): unknown {
  const header = response.headers.get('Retry-After');
  if (header !== null) {
    return header;
  }
  try {
    return readRetryAfterField(JSON.parse(body));
  } catch {
    return undefined;
  }
}

/** Код отказа из тела: сервер кладёт его то в `error`, то в `code` */
function extractErrorCode(body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const candidate = record['error'] ?? record['code'];
  return typeof candidate === 'string' ? candidate : undefined;
}

/**
 * Достаёт массив записей из конверта. Форм наблюдалось три, и различать их по догадке
 * нельзя: `result`, `keys` и голый массив это разные ответы разных ручек.
 */
function extractRows(body: unknown): unknown[] | undefined {
  if (Array.isArray(body)) {
    return body;
  }
  if (body === null || typeof body !== 'object') {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  for (const field of ['result', 'keys']) {
    const candidate = record[field];
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Запись KDC. Ключ без `key_id` или без тела бесполезен, и молча его пропустить нельзя:
 * неполный набор получателей это сообщение, которое часть участников не прочтёт, причём
 * узнать об этом будет уже негде. Поэтому неразобранная запись это ошибка, а не пропуск.
 */
function toKdcKey(row: unknown, index: number): KdcKey {
  if (row === null || typeof row !== 'object') {
    throw new RestError(200, 'unexpected_shape', `запись KDC ${index} не является объектом`);
  }
  const record = row as Record<string, unknown>;
  const keyId = record['key_id'] ?? record['id'];
  const body = record['body'];
  if (typeof keyId !== 'string' || typeof body !== 'string') {
    throw new RestError(200, 'unexpected_shape', `запись KDC ${index} без key_id или body`);
  }
  return {
    key_id: keyId,
    algo: typeof record['algo'] === 'string' ? record['algo'] : '',
    kind: typeof record['kind'] === 'string' ? record['kind'] : '',
    body,
  };
}

export class HttpRestClient implements RestClient {
  private readonly doFetch: typeof fetch;
  private readonly doSleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: HttpRestClientDeps) {
    this.doFetch = deps.fetchImplementation ?? globalThis.fetch;
    this.doSleep = deps.sleepImplementation ?? sleep;
  }

  async getJson<T>(path: string, query?: Record<string, string>): Promise<T> {
    try {
      return await this.attempt<T>(path, query);
    } catch (error) {
      /*
       * Просьба подождать это не отказ: GET идемпотентен, поэтому повтор после паузы
       * безопасен. Повтор ровно один: сервер, повторивший просьбу, имеет в виду не паузу,
       * а исчерпанную квоту, и дальнейшие попытки только тратят её остаток.
       */
      if (error instanceof RateLimitError) {
        this.deps.logger?.warn('rest: лимит частоты, пауза и один повтор', {
          path,
          pauseMs: error.pauseMs,
        });
        await this.doSleep(error.pauseMs);
        return this.attempt<T>(path, query);
      }
      if (!(error instanceof AuthError) || error.kind !== 'bearer') {
        throw error;
      }
      this.deps.logger?.warn('rest: bearer отвергнут, сброс кэша авторизации и один повтор', { path });
      await this.deps.auth.onAuthFailure();
      /* Второй отказ уходит наверх как AuthError: дело не в протухшем токене */
      return this.attempt<T>(path, query);
    }
  }

  async getKdcKeys(ids: readonly string[]): Promise<KdcKey[]> {
    if (ids.length === 0) {
      return [];
    }
    const body = await this.getJson<unknown>(this.deps.config.protocol.kdcKeysPath, { ids: ids.join(',') });
    const rows = extractRows(body);
    if (rows === undefined) {
      throw new RestError(
        200,
        'unexpected_shape',
        'ответ KDC не содержит массива ни в result, ни в keys, ни сам по себе',
      );
    }
    return rows.map(toKdcKey);
  }

  private async attempt<T>(path: string, query?: Record<string, string>): Promise<T> {
    const [bearer, cookieHeader] = await Promise.all([
      this.deps.auth.getBearer(),
      this.deps.auth.getCookieHeader(),
    ]);

    const url = new URL(`${this.deps.config.protocol.restBaseUrl}${path}`);
    for (const [name, value] of Object.entries(query ?? {})) {
      url.searchParams.set(name, value);
    }

    const response = await this.doFetch(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${bearer}`,
        Cookie: cookieHeader,
        Accept: 'application/json',
        'User-Agent': this.deps.config.protocol.userAgent,
      },
    });

    if (response.status === 401) {
      throw new AuthError(`rest ${path} отверг bearer (HTTP 401)`, 'bearer');
    }

    const text = await response.text();
    if (response.status === RATE_LIMIT_STATUS) {
      const rawPause = extractRawPause(response, text);
      throw new RateLimitError(
        resolvePauseMs(rawPause, this.deps.logger),
        extractErrorCode(text),
        toBodySnippet(text),
      );
    }
    if (!response.ok) {
      throw new RestError(response.status, extractErrorCode(text), toBodySnippet(text));
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new RestError(response.status, 'invalid_json', toBodySnippet(text));
    }
  }
}
