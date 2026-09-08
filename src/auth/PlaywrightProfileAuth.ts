/**
 * Реализация порта авторизации поверх persistent-профиля Playwright.
 *
 * ЕДИНСТВЕННОЕ место во всём коде, где есть браузер, профиль и IndexedDB. Транспорт и крипто
 * знают только порт `AuthProvider`, и это не вкусовщина: у ключевого материала обязан быть
 * ровно один владелец, иначе редакция логов, инвалидация кэша и границы доверия
 * размазываются по слоям.
 *
 * Браузер поднимается только ради снимка сессии: дальше весь протокол гоняется в Node.
 */
import { chromium } from 'playwright';
import type { Config } from '../config/types.js';
import { AUTHENTICATE_EVENT } from '../config/wireEvents.js';
import { asObject, stringOr } from '../util/json.js';
import type { Logger } from '../util/logger.js';
import { AuthError, type AuthProvider, type KeyMaterial, type Whoami } from './AuthProvider.js';
import type { ProfileSession, ProfileSessionSource } from './ProfileSessionSource.js';
import {
  buildCookieHeader,
  extractHuidFromProfiles,
  extractKeyMaterialFromAuthState,
  parseWsParams,
  type ProfileCookie,
} from './profileMaterial.js';

const BEARER_PREFIX = 'Bearer ';

/** Шаг опроса перехваченных величин: секунды входа не экономим, лишние такты не жжём */
const POLL_INTERVAL_MS = 250;

/**
 * Окно ожидания кадра authenticate после того, как заголовочный токен уже пойман.
 *
 * Кадр несёт САМЫЙ свежий bearer (сокет авторизуется уже после стартового рефреша), поэтому
 * его стоит подождать. Но ждать его до общего таймаута нельзя: профиль, где сокет молчит,
 * жёг бы весь бюджет входа при полностью рабочих кредах.
 */
const AUTHENTICATE_FRAME_GRACE_MS = 3_000;

/**
 * Чтение записей IndexedDB `authState`/items.
 *
 * Строкой, а не функцией: код исполняется в браузере, где живёт `indexedDB`, которого нет
 * ни в типах Node, ни в рантайме процесса. Строка держит браузерный код целиком по ту
 * сторону шва и не тянет в проект DOM-типы ради одного вызова.
 */
const READ_AUTH_STATE_ROWS = `(async () => {
  const openDatabase = (name) => new Promise((resolve) => {
    const request = indexedDB.open(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
  const database = await openDatabase('authState');
  if (!database) return [];
  let rows = [];
  try {
    rows = await new Promise((resolve) => {
      const collected = [];
      const cursor = database.transaction('items', 'readonly').objectStore('items').openCursor();
      cursor.onsuccess = (event) => {
        const current = event.target.result;
        if (!current) { resolve(collected); return; }
        collected.push(current.value);
        current.continue();
      };
      cursor.onerror = () => resolve(collected);
    });
  } catch (error) {
    rows = [];
  }
  database.close();
  return rows;
})()`;

/** Чтение записи `profiles` среза redux: в ней лежит признак «это я» вместе с huid */
const READ_REDUX_PROFILES = `(async () => {
  const openDatabase = (name) => new Promise((resolve) => {
    const request = indexedDB.open(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
  const database = await openDatabase('reduxState');
  if (!database) return null;
  let value = null;
  try {
    value = await new Promise((resolve) => {
      const request = database.transaction('items', 'readonly').objectStore('items').get('profiles');
      request.onsuccess = () => resolve(request.result === undefined ? null : request.result);
      request.onerror = () => resolve(null);
    });
  } catch (error) {
    value = null;
  }
  database.close();
  return value === undefined ? null : value;
})()`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function readBearerHeader(headers: Record<string, string>): string | undefined {
  const value = headers['authorization'] ?? headers['Authorization'];
  if (value === undefined || !value.startsWith(BEARER_PREFIX)) {
    return undefined;
  }
  return stringOr(value.slice(BEARER_PREFIX.length));
}

/** Токен из кадра `authenticate`: им сокет веб-клиента авторизуется, свежее него ничего нет */
function readAuthenticateToken(payload: string | Buffer): string | undefined {
  const text = typeof payload === 'string' ? payload : payload.toString('utf8');
  /* Дешёвый отсев: кадров за сессию сотни, разбирать JSON на каждом незачем */
  if (!text.includes(`"${AUTHENTICATE_EVENT}"`)) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const frame = asObject(parsed);
  if (frame === undefined || frame['event'] !== AUTHENTICATE_EVENT) {
    return undefined;
  }
  return stringOr(asObject(frame['payload'])?.['token']);
}

/** Исход одной попытки: либо снимок, либо причина, годная в текст отказа */
type AttemptResult = { session: ProfileSession } | { failure: string };

/** Запрос страницы: снимку нужен ровно один его заголовок */
export interface ProfileRequest {
  headers(): Record<string, string>;
}

/** Кадр сокета: полезна только его нагрузка */
export interface ProfileWebSocketFrame {
  payload: string | Buffer;
}

/** Сокет страницы: адрес сессии и исходящие кадры */
export interface ProfileWebSocket {
  url(): string;
  on(event: 'framesent', handler: (frame: ProfileWebSocketFrame) => void): void;
}

/**
 * Страница браузера в объёме, который нужен снимку.
 *
 * Интерфейс структурный и намеренно узкий: настоящая страница Playwright подходит под него
 * как есть, а подложная реализация теста не обязана изображать сотню чужих методов.
 */
export interface ProfilePage {
  on(event: 'request', handler: (request: ProfileRequest) => void): void;
  on(event: 'websocket', handler: (socket: ProfileWebSocket) => void): void;
  goto(url: string, options: { waitUntil: 'domcontentloaded' }): Promise<unknown>;
  evaluate<Result>(script: string): Promise<Result>;
}

/** Контекст персистентного профиля в объёме, который нужен снимку */
export interface ProfileBrowserContext {
  pages(): ProfilePage[];
  newPage(): Promise<ProfilePage>;
  cookies(): Promise<ProfileCookie[]>;
  close(): Promise<void>;
}

export interface LaunchProfileContextOptions {
  profileDir: string;
  headless: boolean;
}

/** Шов запуска браузера: единственное место попытки, которому нужен настоящий Chromium */
export type LaunchProfileContext = (
  options: LaunchProfileContextOptions,
) => Promise<ProfileBrowserContext>;

/**
 * Запуск настоящего браузера на персистентном профиле.
 *
 * Вынесен отдельной функцией ради шва: эскалация headless в headed это поведение с
 * бюджетами в десятки секунд и минуты, и проверять его настоящим Chromium значит либо
 * не проверять вовсе, либо держать тест, который зависит от машины и от живой сессии.
 */
async function launchPersistentProfileContext({
  profileDir,
  headless,
}: LaunchProfileContextOptions): Promise<ProfileBrowserContext> {
  return chromium.launchPersistentContext(profileDir, {
    headless,
    args: ['--disable-blink-features=AutomationControlled'],
  });
}

export interface PlaywrightProfileSourceOptions {
  config: Config;
  logger: Logger;
  /** Подменяется в тестах: подложный контекст доказывает эскалацию входа без браузера */
  launchContext?: LaunchProfileContext;
}

/**
 * Подъём persistent-профиля: снимок сессии за один заход браузера.
 *
 * `load()` и `refresh()` делают одно и то же намеренно. Bearer непрозрачен (не JWT, срок
 * жизни из него не читается), обновляет его само веб-приложение запросом
 * POST /api/v1/ad_integration/token/refresh на старте вкладки. Значит наш способ получить
 * свежий токен ровно один: открыть профиль и перехватить то, чем авторизуется приложение.
 */
export class PlaywrightProfileSource implements ProfileSessionSource {
  constructor(private readonly options: PlaywrightProfileSourceOptions) {}

  async load(): Promise<ProfileSession> {
    return this.capture();
  }

  async refresh(): Promise<ProfileSession> {
    return this.capture();
  }

  /** Headless-заход, при неуспехе headed с ручным входом; провал обеих попыток это отказ */
  private async capture(): Promise<ProfileSession> {
    const { config, logger } = this.options;

    const headless = await this.attempt(true, config.auth.headlessTimeoutMs);
    if ('session' in headless) {
      return headless.session;
    }

    logger.warn('auth: headless-вход не дал сессии, откроется окно браузера для ручного входа', {
      profileDir: config.paths.profileDir,
      reason: headless.failure,
      waitMs: config.auth.headedTimeoutMs,
    });

    const headed = await this.attempt(false, config.auth.headedTimeoutMs);
    if ('session' in headed) {
      return headed.session;
    }

    throw new AuthError(
      `Не удалось получить сессию Клаудс. Headless: ${headless.failure}. С окном: ${headed.failure}. ` +
        `Войдите в аккаунт в открывшемся браузере (профиль: ${config.paths.profileDir}).`,
      'bearer',
    );
  }

  /**
   * Один заход браузера: перехват, стабилизация, чтение профиля.
   *
   * Всё чтение идёт ДО закрытия контекста, потому что после закрытия ни cookie, ни
   * IndexedDB уже не достать, а второй заход дал бы величины другой сессии.
   */
  private async attempt(headless: boolean, timeoutMs: number): Promise<AttemptResult> {
    const { config, logger } = this.options;
    const launch = this.options.launchContext ?? launchPersistentProfileContext;
    const context = await launch({ profileDir: config.paths.profileDir, headless });

    try {
      const page = context.pages()[0] ?? (await context.newPage());

      let headerBearer: string | undefined;
      let socketBearer: string | undefined;
      let socketUrl: string | undefined;

      page.on('request', (request) => {
        const bearer = readBearerHeader(request.headers());
        /*
         * Побеждает последний, а не первый: профиль стартует с протухшим токеном, и первый
         * же перехваченный заголовок это ровно он. Клиент меняет токен рефрешем на второй
         * секунде, и именно поздний заголовок несёт рабочее значение.
         */
        if (bearer !== undefined) {
          headerBearer = bearer;
        }
      });

      page.on('websocket', (socket) => {
        socketUrl ??= socket.url();
        socket.on('framesent', (frame) => {
          const token = readAuthenticateToken(frame.payload);
          if (token === undefined) {
            return;
          }
          socketBearer = token;
          /* Параметры сессии берутся с ТОГО сокета, который прошёл аутентификацию */
          socketUrl = socket.url();
        });
      });

      await page.goto(`${config.protocol.webOrigin}/#/`, { waitUntil: 'domcontentloaded' }).catch(() => {
        /* Сеть могла моргнуть: стабилизацию всё равно ждём по перехвату, а не по навигации */
      });

      const deadline = Date.now() + timeoutMs;
      let graceDeadline: number | undefined;
      for (;;) {
        if (socketUrl !== undefined && socketBearer !== undefined) {
          break;
        }
        const now = Date.now();
        if (socketUrl !== undefined && headerBearer !== undefined) {
          graceDeadline ??= now + AUTHENTICATE_FRAME_GRACE_MS;
          if (now >= graceDeadline) {
            break;
          }
        }
        if (now >= deadline) {
          break;
        }
        await sleep(POLL_INTERVAL_MS);
      }

      const bearer = socketBearer ?? headerBearer;
      if (bearer === undefined || socketUrl === undefined) {
        return {
          failure:
            `сессия не стабилизировалась за ${timeoutMs} мс ` +
            `(токен: ${bearer !== undefined ? 'есть' : 'нет'}, сокет: ${socketUrl !== undefined ? 'есть' : 'нет'})`,
        };
      }

      const wsParams = parseWsParams(socketUrl);
      if (wsParams === undefined) {
        return { failure: 'в url сокета нет key_id и instance_id' };
      }

      const cookieHeader = buildCookieHeader(await context.cookies(), this.sessionHosts());
      if (cookieHeader.length === 0) {
        return { failure: 'в профиле нет cookie хостов сессии' };
      }

      const material = extractKeyMaterialFromAuthState(await page.evaluate<unknown[]>(READ_AUTH_STATE_ROWS));
      if (material === undefined) {
        return { failure: 'в профиле не найден ключевой материал (authState/items)' };
      }

      const huid = extractHuidFromProfiles(await page.evaluate<unknown>(READ_REDUX_PROFILES));
      if (huid === undefined) {
        return { failure: 'в профиле не найден huid (reduxState/items, profiles)' };
      }

      /*
       * Имена полей намеренно обходят словарь редакции логгера: поле с «bearer», «cookie»
       * или «key» в имени приехало бы в лог как [redacted], и диагностика длин потерялась бы.
       */
      logger.info('auth: снимок профиля собран', {
        headless,
        fromAuthenticateFrame: socketBearer !== undefined,
        accessLength: bearer.length,
        sessionHeaderLength: cookieHeader.length,
        hasCts: material.privateKeys.cts !== undefined,
        hasRts: material.privateKeys.rts !== undefined,
      });

      return {
        session: {
          bearer,
          cookieHeader,
          huid,
          keyMaterial: { ...material, wsParams },
        },
      };
    } finally {
      await context.close();
    }
  }

  /**
   * Хосты, чьи cookie уезжают на сервер. Собираются из конфига, а не зашиты: веб-клиент и
   * cts-хост это разные имена, и в белом списке обязаны быть оба.
   */
  private sessionHosts(): string[] {
    const { protocol } = this.options.config;
    const hosts = new Set<string>();
    for (const candidate of [protocol.webOrigin, protocol.restBaseUrl, protocol.wsUrl]) {
      try {
        hosts.add(new URL(candidate).hostname);
      } catch {
        /* Битый url в конфиге не повод ронять вход: остальные хосты всё равно нужны */
      }
    }
    return [...hosts];
  }
}

export interface PlaywrightProfileAuthOptions {
  config: Config;
  logger: Logger;
  /** Подменяется в тестах: подложный источник доказывает схлопывание без браузера */
  source?: ProfileSessionSource;
}

/**
 * Кэш снимка профиля за портом `AuthProvider`.
 *
 * Схлопывание параллельных входов здесь не оптимизация, а условие работоспособности: два
 * `launchPersistentContext` на одном каталоге профиля упираются в singleton-lock Chromium,
 * а одновременный отказ на сокете и на REST это ровно два вызова.
 *
 * Проактивного TTL нет: bearer непрозрачен, срок жизни из него не читается (Ф2), поэтому
 * обновление только реактивное, по `getBearer(true)` и `onAuthFailure()`. Это записанный долг.
 */
export class PlaywrightProfileAuth implements AuthProvider {
  private readonly source: ProfileSessionSource;
  private cached: ProfileSession | undefined;
  private pending: Promise<ProfileSession> | undefined;
  private refreshing: Promise<ProfileSession> | undefined;
  /**
   * Эпоха кэша. Инкрементируется каждой инвалидацией, чтобы подъём, стартовавший ДО неё,
   * не записал в кэш уже отозванную сессию, зарезолвившись после.
   */
  private generation = 0;

  constructor(private readonly options: PlaywrightProfileAuthOptions) {
    this.source =
      options.source ?? new PlaywrightProfileSource({ config: options.config, logger: options.logger });
  }

  async getBearer(forceRefresh = false): Promise<string> {
    const session = forceRefresh ? await this.refreshSession() : await this.session();
    return session.bearer;
  }

  async getCookieHeader(): Promise<string> {
    return (await this.session()).cookieHeader;
  }

  async getWhoami(): Promise<Whoami> {
    return { huid: (await this.session()).huid };
  }

  async getKeyMaterial(): Promise<KeyMaterial> {
    return (await this.session()).keyMaterial;
  }

  async onAuthFailure(): Promise<void> {
    this.options.logger.warn('auth: креды отвергнуты, профиль поднимается заново');
    await this.refreshSession();
  }

  private async session(): Promise<ProfileSession> {
    if (this.cached !== undefined) {
      return this.cached;
    }
    /* Обновление уже идёт: примыкаем к нему, иначе получим второй Chromium на том же профиле */
    if (this.refreshing !== undefined) {
      return this.refreshing;
    }
    if (this.pending === undefined) {
      const generation = this.generation;
      const pending = this.source
        .load()
        .then((session) => this.commit(session, generation))
        .finally(() => {
          /* Сверка по ссылке: инвалидация могла обнулить pending и запустить новый подъём */
          if (this.pending === pending) {
            this.pending = undefined;
          }
        });
      this.pending = pending;
    }
    return this.pending;
  }

  /**
   * Единственная дверь к `source.refresh()`: серия параллельных отказов даёт один подъём.
   *
   * Эпоха двигается только вместе с НАЧАЛОМ подъёма, а не на каждом вызове. Иначе второй
   * вызов серии, примкнувший к уже идущему подъёму, объявил бы его результат устаревшим,
   * и свежая сессия не попала бы в кэш ни разу.
   */
  private async refreshSession(): Promise<ProfileSession> {
    if (this.refreshing === undefined) {
      this.generation += 1;
      this.cached = undefined;
      /* Подъём на отозванных кредах бросаем: его результат новым вызывающим уже не годен */
      this.pending = undefined;
      const generation = this.generation;
      const refreshing = this.source
        .refresh()
        .then((session) => this.commit(session, generation))
        .finally(() => {
          if (this.refreshing === refreshing) {
            this.refreshing = undefined;
          }
        });
      this.refreshing = refreshing;
    }
    return this.refreshing;
  }

  /** Пишет кэш, только если за время подъёма не случилось инвалидации */
  private commit(session: ProfileSession, generation: number): ProfileSession {
    if (generation === this.generation) {
      this.cached = session;
    } else {
      this.options.logger.warn('auth: снимок собран на отозванной сессии, кэш не обновляем');
    }
    return session;
  }
}
