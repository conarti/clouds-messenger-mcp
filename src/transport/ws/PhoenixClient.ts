/**
 * Phoenix Channels поверх WebSocket: единственный путь чтения и отправки (Фаза 0).
 *
 * Клиент САМ собирает адрес хендшейка, потому что сборка query это знание транспорта,
 * а не слоя авторизации: слой авторизации отдаёт только материал сессии (`key_id`,
 * `instance_id`, bearer, cookie), и о версии сокета ничего не знает.
 *
 * Три вещи, ради которых этот класс выглядит сложнее наивного клиента:
 *
 *  1. ПОВТОР AUTHENTICATE. Живьём наблюдалось, что первый кадр `authenticate` остаётся
 *     без ответа (findings.md, «Грабли»). Соединение при этом живо, поэтому лечение
 *     единственное: послать кадр ещё раз с НОВЫМ ref. Ретрай считается попытками, а не
 *     временем, чтобы поведение было воспроизводимо тестом.
 *
 *  2. СОСТОЯНИЕ НА СОЕДИНЕНИИ. Счётчик ref и карта ожиданий живут на объекте соединения,
 *     а не на клиенте. После переподключения ref начинается заново, и значения неизбежно
 *     повторяются: ожидания, привязанные к клиенту, отдали бы ответ старого соединения
 *     новому запросу с тем же номером, то есть перепутали бы содержимое ответов.
 *
 *  3. ПРАВО НА ПОВТОР. Повтор запроса после обрыва разрешён только чтению. Отправка
 *     необратима: сервер мог принять кадр и не успеть ответить, и слепой повтор задвоил бы
 *     сообщение у собеседника. Поэтому `retry:false` не повторяется НИКОГДА, ни после
 *     обрыва, ни по таймауту.
 *
 *  4. ЗАКРЫТИЕ ПО ПРОСТОЮ. Открытый сокет это не только ресурс, но и заявление: мессенджер
 *     показывает владельца сессии в сети, пока соединение живо. Поэтому простой закрывает
 *     соединение сам, а следующий запрос поднимает его заново через `ensureConnection`.
 *     Закрытие штатное и наружу не видно ничем, кроме одной повторной авторизации сокета.
 */
import WebSocket from 'ws';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { AuthError, type AuthProvider, type WsParams } from '../../auth/AuthProvider.js';
import type { Config } from '../../config/types.js';
import type { Logger } from '../../util/logger.js';
import { exponentialDelayMs, sleep } from '../backoff.js';
import { isRateLimitCode, readRetryAfterField, resolvePauseMs } from '../rateLimit.js';
import {
  AUTHENTICATE_EVENT,
  decodeFrame,
  encodeFrame,
  HEARTBEAT_EVENT,
  isReply,
  parseReply,
  PHOENIX_TOPIC,
  type PhoenixFrame,
} from './frames.js';
import type { PhoenixClient, PhoenixRequestOptions } from './types.js';

/** Соединение закрылось раньше, чем пришёл ответ */
export class WsClosedError extends Error {
  constructor(reason: string) {
    super(`ws: соединение закрыто до ответа (${reason})`);
    this.name = 'WsClosedError';
  }
}

/** Ответ не пришёл в отведённый срок: соединение живо, но сервер молчит */
export class WsTimeoutError extends Error {
  constructor(
    readonly topic: string,
    readonly event: string,
    timeoutMs: number,
  ) {
    super(`ws ${topic}/${event}: ответ не пришёл за ${timeoutMs}мс`);
    this.name = 'WsTimeoutError';
  }
}

/** Прикладной отказ сервера: `phx_reply` со `status:"error"` */
export class PhoenixReplyError extends Error {
  constructor(
    readonly code: string,
    readonly topic: string,
    readonly event: string,
    readonly response: unknown,
  ) {
    super(`ws ${topic}/${event} отклонён сервером: ${code}`);
    this.name = 'PhoenixReplyError';
  }
}

interface PendingRequest {
  topic: string;
  event: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Состояние одного соединения. Живёт ровно столько, сколько живёт сокет: после обрыва
 * объект выбрасывается целиком вместе со счётчиком ref и ожиданиями.
 */
interface Connection {
  socket: WebSocket;
  /** Первый кадр `authenticate` уходит с ref 0, как у живого клиента */
  nextRef: number;
  pending: Map<number, PendingRequest>;
  heartbeatTimer: NodeJS.Timeout | undefined;
  idleTimer: NodeJS.Timeout | undefined;
  /** Момент последнего обмена: из него берётся длительность простоя для лога закрытия */
  lastExchangeAt: number;
  closed: boolean;
}

export interface PhoenixWsClientDeps {
  auth: AuthProvider;
  config: Config;
  logger?: Logger;
}

/** Слушатель кадров, инициированных сервером */
export type ServerEventListener = (frame: PhoenixFrame) => void;

/**
 * Собирает адрес хендшейка. Порядок параметров сохраняется тот же, что у живого клиента:
 * сервер к порядку безразличен, но совпадение байт в байт делает расхождение с пробой
 * видимым сразу, а не через отказ на проде.
 */
function buildSocketUrl(config: Config, wsParams: WsParams): string {
  const query = new URLSearchParams({
    vsn: config.protocol.wsVsn,
    auto_join: 'true',
    key_id: wsParams.keyId,
    version: String(config.protocol.wsVersion),
    background: 'false',
    instance_id: wsParams.instanceId,
  });
  return `${config.protocol.wsUrl}?${query.toString()}`;
}

/** Отказ авторизации на уровне HTTP-апгрейда */
function isAuthStatus(status: number): boolean {
  return status === 401 || status === 403;
}

export class PhoenixWsClient implements PhoenixClient {
  private connection: Connection | undefined;
  private connecting: Promise<Connection> | undefined;
  private disposed = false;
  private readonly eventListeners = new Set<ServerEventListener>();

  constructor(private readonly deps: PhoenixWsClientDeps) {}

  /** Поднимает соединение и проходит authenticate; повторный вызов переиспользует живое */
  async connect(): Promise<void> {
    await this.ensureConnection();
  }

  /**
   * Подписка на кадры сервера (`app_event` и прочие события без нашего ref).
   * Возвращает функцию отписки: слушатель, переживший своего владельца, держал бы его в памяти.
   */
  onEvent(listener: ServerEventListener): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  async request<T>(
    topic: string,
    event: string,
    payload: unknown,
    options: PhoenixRequestOptions = {},
  ): Promise<T> {
    /* Чтение повторяемо по умолчанию, отправка обязана выключить повтор явно */
    const retryAllowed = options.retry ?? true;
    const budget = Math.max(1, this.deps.config.ws.reconnectAttempts);
    let attempt = 0;

    for (;;) {
      attempt += 1;
      try {
        return (await this.attempt(topic, event, payload, options)) as T;
      } catch (error) {
        /*
         * Просьба подождать приезжает прикладным отказом, а не обрывом, поэтому она
         * разбирается до общей проверки повторяемости. Право на повтор при этом то же
         * самое: отправка необратима, и пауза не даёт ей никакой новой безопасности,
         * поэтому `retry:false` уходит наружу с кодом, а паузу выдерживает вызывающий.
         */
        const pauseMs = rateLimitPauseMs(error, this.deps.logger);
        if (pauseMs !== undefined) {
          if (!retryAllowed || attempt >= budget) {
            throw error;
          }
          this.deps.logger?.warn('ws: лимит частоты, пауза перед повтором', {
            topic,
            event,
            attempt,
            pauseMs,
          });
          await sleep(pauseMs);
          continue;
        }
        if (!retryAllowed || !isRetriable(error) || attempt >= budget) {
          throw error;
        }
        const delayMs = exponentialDelayMs(attempt, {
          baseDelayMs: this.deps.config.ws.reconnectBaseDelayMs,
          maxDelayMs: this.deps.config.ws.reconnectMaxDelayMs,
        });
        this.deps.logger?.warn('ws: повтор запроса после обрыва', {
          topic,
          event,
          attempt,
          delayMs,
        });
        await sleep(delayMs);
      }
    }
  }

  async close(): Promise<void> {
    this.disposed = true;
    this.dropConnection('клиент закрыт');
  }

  private async attempt(
    topic: string,
    event: string,
    payload: unknown,
    options: PhoenixRequestOptions,
  ): Promise<unknown> {
    const connection = await this.ensureConnection();
    const ref = connection.nextRef;
    connection.nextRef += 1;
    const timeoutMs = options.timeoutMs ?? this.deps.config.ws.requestTimeoutMs;
    this.restartIdleTimer(connection);
    return this.sendAndWait(connection, { topic, event, payload, ref }, timeoutMs);
  }

  private async ensureConnection(): Promise<Connection> {
    if (this.disposed) {
      throw new Error('ws: клиент закрыт');
    }
    const current = this.connection;
    if (current !== undefined && !current.closed) {
      return current;
    }
    /* Параллельные запросы схлопываются в один хендшейк */
    this.connecting ??= this.openConnection().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  /**
   * Полный цикл подключения: хендшейк, затем authenticate.
   *
   * `allowAuthRetry` тратится ровно один раз: отвергнутый bearer лечится сбросом кэша
   * авторизации и одной повторной попыткой. Второй отказ означает, что дело не в токене,
   * и цикл повторов здесь превратился бы в бесконечный вход.
   */
  private async openConnection(allowAuthRetry = true): Promise<Connection> {
    const [bearer, cookieHeader, keyMaterial] = await Promise.all([
      this.deps.auth.getBearer(),
      this.deps.auth.getCookieHeader(),
      this.deps.auth.getKeyMaterial(),
    ]);

    const url = buildSocketUrl(this.deps.config, keyMaterial.wsParams);
    const socket = new WebSocket(url, {
      headers: {
        Origin: this.deps.config.protocol.webOrigin,
        Cookie: cookieHeader,
        'User-Agent': this.deps.config.protocol.userAgent,
      },
    });

    const connection: Connection = {
      socket,
      nextRef: 0,
      pending: new Map(),
      heartbeatTimer: undefined,
      idleTimer: undefined,
      lastExchangeAt: Date.now(),
      closed: false,
    };

    /* Слушатели вешаются до ожидания open: кадр сервера может прийти сразу после апгрейда */
    socket.on('message', (data: Buffer) => {
      this.onMessage(connection, data.toString('utf8'));
    });
    socket.on('close', (code: number, reason: Buffer) => {
      this.onClose(connection, `${code} ${reason.toString()}`.trim());
    });
    socket.on('error', (error: Error) => {
      this.deps.logger?.debug('ws: ошибка сокета', { error });
    });

    try {
      await waitForOpen(socket);
      await this.authenticate(connection, bearer);
    } catch (error) {
      this.onClose(connection, 'подключение не состоялось');
      socket.terminate();
      if (allowAuthRetry && error instanceof AuthError && error.kind === 'bearer') {
        this.deps.logger?.warn('ws: bearer отвергнут, сброс кэша авторизации и один повтор');
        await this.deps.auth.onAuthFailure();
        return this.openConnection(false);
      }
      throw error;
    }

    this.startHeartbeat(connection);
    this.connection = connection;
    /*
     * Отсчёт простоя заводится только после регистрации соединения: сработай он раньше,
     * закрывать было бы нечего, а вернувшийся из хендшейка объект оказался бы уже мёртвым.
     */
    this.restartIdleTimer(connection);
    this.deps.logger?.info('ws: соединение открыто и аутентифицировано');
    return connection;
  }

  /**
   * Кадр `authenticate` с bearer. Молчание сервера лечится повтором кадра с новым ref
   * (findings.md, «Грабли»): именно молчание, а не отказ. Отказ означает плохой токен и
   * поднимается наверх как AuthError, чтобы сработал единственный повтор подключения.
   */
  private async authenticate(connection: Connection, bearer: string): Promise<void> {
    const attempts = Math.max(1, this.deps.config.ws.authenticateAttempts);
    const timeoutMs = this.deps.config.ws.authenticateTimeoutMs;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const ref = connection.nextRef;
      connection.nextRef += 1;
      try {
        await this.sendAndWait(
          connection,
          { topic: PHOENIX_TOPIC, event: AUTHENTICATE_EVENT, payload: { token: bearer }, ref },
          timeoutMs,
        );
        this.deps.logger?.debug('ws: authenticate принят', { attempt, bearerLength: bearer.length });
        return;
      } catch (error) {
        if (error instanceof PhoenixReplyError) {
          throw new AuthError(`ws: сокет отверг bearer на authenticate (${error.code})`, 'bearer');
        }
        if (!(error instanceof WsTimeoutError)) {
          throw error;
        }
        this.deps.logger?.warn('ws: authenticate остался без ответа, повтор с новым ref', {
          attempt,
          timeoutMs,
        });
      }
    }

    throw new AuthError(`ws: authenticate без ответа за ${attempts} попыток`, 'protocol');
  }

  private sendAndWait(connection: Connection, frame: PhoenixFrame, timeoutMs: number): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const ref = frame.ref;
      if (ref === null) {
        reject(new Error('ws: кадр запроса обязан нести ref'));
        return;
      }
      const pending: PendingRequest = {
        topic: frame.topic,
        event: frame.event,
        resolve,
        reject,
        timer: setTimeout(() => {
          connection.pending.delete(ref);
          reject(new WsTimeoutError(frame.topic, frame.event, timeoutMs));
        }, timeoutMs),
      };
      connection.pending.set(ref, pending);
      this.deps.logger?.debug('ws: кадр отправлен', { topic: frame.topic, event: frame.event, ref });
      /* Библиотека зовёт колбэк с null при успехе, поэтому проверяется наличие ошибки */
      connection.socket.send(encodeFrame(frame), (error) => {
        if (error) {
          this.settle(connection, ref, (item) => item.reject(error));
        }
      });
    });
  }

  private onMessage(connection: Connection, raw: string): void {
    const decoded = decodeFrame(raw);
    if (!decoded.ok) {
      this.deps.logger?.warn('ws: кадр не разобран', { reason: decoded.reason });
      return;
    }

    const frame = decoded.frame;
    if (isReply(frame) && frame.ref !== null) {
      this.settleReply(connection, frame, frame.ref);
      return;
    }

    /*
     * Кадр сервера: событие без нашего ref. Транспорт обязан его принять и не спутать
     * с ответом, иначе живая подписка ломала бы корреляцию запросов.
     */
    this.deps.logger?.debug('ws: кадр сервера', { topic: frame.topic, event: frame.event });
    for (const listener of this.eventListeners) {
      listener(frame);
    }
  }

  private settleReply(connection: Connection, frame: PhoenixFrame, ref: number): void {
    this.settle(connection, ref, (pending) => {
      const reply = parseReply(frame);
      if (reply.status === 'ok') {
        pending.resolve(reply.response);
        return;
      }
      pending.reject(
        new PhoenixReplyError(reply.errorCode ?? 'unknown', pending.topic, pending.event, reply.response),
      );
    });
  }

  private settle(connection: Connection, ref: number, apply: (pending: PendingRequest) => void): void {
    const pending = connection.pending.get(ref);
    if (pending === undefined) {
      /* Ответ на снятое ожидание: так выглядит запоздалый ответ на первый authenticate */
      this.deps.logger?.debug('ws: ответ без ожидающего запроса', { ref });
      return;
    }
    connection.pending.delete(ref);
    clearTimeout(pending.timer);
    /*
     * Отсчёт простоя перезапускается на ответе, а не только на отправке: обмен закончился
     * именно здесь. Heartbeat ожидания не заводит и до этой строки не доходит, поэтому
     * служебный кадр соединение не продлевает и простой остаётся простоем.
     */
    this.restartIdleTimer(connection);
    apply(pending);
  }

  /**
   * Перезапускает отсчёт простоя. Таймер снимает ref с процесса: он фоновая уборка, и
   * держать ради неё живым сервер, которому больше нечего делать, было бы неправильно.
   */
  private restartIdleTimer(connection: Connection): void {
    connection.lastExchangeAt = Date.now();
    if (connection.idleTimer !== undefined) {
      clearTimeout(connection.idleTimer);
      connection.idleTimer = undefined;
    }
    const idleCloseMs = this.deps.config.ws.idleCloseMs;
    if (idleCloseMs <= 0 || connection.closed) {
      return;
    }
    const timer = setTimeout(() => {
      this.onIdleDeadline(connection);
    }, idleCloseMs);
    timer.unref();
    connection.idleTimer = timer;
  }

  /**
   * Срок простоя вышел. Запрос в полёте отменяет закрытие и переносит его на следующий
   * интервал: соединение, закрытое под ожиданием, отняло бы у вызывающего готовый ответ,
   * а ради экономии присутствия терять ответы нельзя.
   */
  private onIdleDeadline(connection: Connection): void {
    if (connection.closed) {
      return;
    }
    if (connection.pending.size > 0) {
      this.restartIdleTimer(connection);
      return;
    }
    this.deps.logger?.info('ws: соединение закрыто по простою', {
      idleMs: Date.now() - connection.lastExchangeAt,
    });
    this.dropConnection('idle', connection);
  }

  private startHeartbeat(connection: Connection): void {
    const intervalMs = this.deps.config.ws.heartbeatIntervalMs;
    const timer = setInterval(() => {
      if (connection.closed) {
        return;
      }
      const ref = connection.nextRef;
      connection.nextRef += 1;
      connection.socket.send(
        encodeFrame({ topic: PHOENIX_TOPIC, event: HEARTBEAT_EVENT, payload: {}, ref }),
      );
    }, intervalMs);
    /* Heartbeat не имеет права держать процесс живым: это фоновая поддержка, а не работа */
    timer.unref();
    connection.heartbeatTimer = timer;
  }

  private onClose(connection: Connection, reason: string): void {
    if (connection.closed) {
      return;
    }
    connection.closed = true;
    if (connection.heartbeatTimer !== undefined) {
      clearInterval(connection.heartbeatTimer);
    }
    if (connection.idleTimer !== undefined) {
      clearTimeout(connection.idleTimer);
      connection.idleTimer = undefined;
    }
    if (this.connection === connection) {
      this.connection = undefined;
    }

    const error = new WsClosedError(reason);
    for (const pending of connection.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    connection.pending.clear();
    this.deps.logger?.warn('ws: соединение закрыто', { reason });
  }

  /**
   * Закрывает соединение штатно. Цель задаётся явно там, где закрывающий держит ссылку:
   * закрытие по простою обязано попасть ровно в то соединение, чей таймер сработал, а не
   * в текущее, которым к этому моменту может оказаться уже другое.
   */
  private dropConnection(reason: string, target?: Connection): void {
    const connection = target ?? this.connection;
    if (connection === undefined) {
      return;
    }
    connection.socket.close(1000, reason);
    this.onClose(connection, reason);
  }
}

/**
 * Ждёт апгрейда. Отказ 401 и 403 отделяется от прочих отказов: это единственный случай,
 * который лечится сменой bearer, а не повтором.
 */
function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      socket.off('open', onOpen);
      socket.off('error', onError);
      socket.off('unexpected-response', onUnexpectedResponse);
    };
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    /*
     * Библиотека сама закрывает сокет только тогда, когда у события нет слушателя.
     * Раз слушатель есть, TCP-сокет и недренированный ответ закрываются здесь, иначе они
     * висят до keep-alive и держат весь граф соединения.
     */
    const onUnexpectedResponse = (request: ClientRequest, response: IncomingMessage): void => {
      cleanup();
      const status = response.statusCode ?? 0;
      response.destroy();
      request.destroy();
      reject(
        isAuthStatus(status)
          ? new AuthError(`ws: хендшейк отверг сессию (HTTP ${status})`, 'bearer')
          : new Error(`ws: хендшейк вернул HTTP ${status}`),
      );
    };
    socket.once('open', onOpen);
    socket.once('error', onError);
    socket.once('unexpected-response', onUnexpectedResponse);
  });
}

/**
 * Повторять можно только то, что не является решением сервера. Прикладной отказ и отказ
 * авторизации повтором не лечатся: первый вернётся тем же кодом, второй уже отработал
 * свой единственный повтор внутри подключения.
 */
function isRetriable(error: unknown): boolean {
  return !(error instanceof PhoenixReplyError) && !(error instanceof AuthError);
}

/**
 * Отличает просьбу подождать от прочих прикладных отказов. Признаков два, и хватает любого:
 * сервер называет лимит кодом, но величину паузы кладёт в поле, а поле наблюдалось и без
 * кода. Отсутствие величины не отменяет просьбы: пауза тогда берётся минимальная.
 */
function rateLimitPauseMs(error: unknown, logger: Logger | undefined): number | undefined {
  if (!(error instanceof PhoenixReplyError)) {
    return undefined;
  }
  const rawPause = readRetryAfterField(error.response);
  if (!isRateLimitCode(error.code) && rawPause === undefined) {
    return undefined;
  }
  return resolvePauseMs(rawPause, logger);
}
