/**
 * Эскалация входа headless -> headed без настоящего браузера.
 *
 * Проверяется через шов запуска контекста: настоящий Chromium дал бы тест, зависящий от
 * машины, от установленных браузеров и от живой сессии, а бюджеты попыток здесь измеряются
 * десятками секунд и минутами. Подложный контекст оставляет от попытки ровно то, что и
 * должно проверяться: сколько раз поднят профиль, с каким флагом, с каким бюджетом,
 * закрыт ли контекст и что именно уехало в снимок.
 */
import { describe, expect, it } from 'vitest';
import { AuthError } from '../../src/auth/AuthProvider.js';
import {
  PlaywrightProfileAuth,
  PlaywrightProfileSource,
  type LaunchProfileContext,
  type ProfileBrowserContext,
  type ProfilePage,
  type ProfileRequest,
  type ProfileWebSocket,
  type ProfileWebSocketFrame,
} from '../../src/auth/PlaywrightProfileAuth.js';
import type { ProfileCookie } from '../../src/auth/profileMaterial.js';
import type { Config } from '../../src/config/types.js';
import { AUTHENTICATE_EVENT } from '../../src/transport/ws/frames.js';
import type { LogFields, Logger } from '../../src/util/logger.js';
import { createTestConfig } from '../helpers/testConfig.js';

/**
 * Бюджеты попыток в тесте на три порядка меньше рабочих: проверяется эскалация, а не
 * терпение. Значения разные намеренно, иначе текст отказа не отличил бы, какая из двух
 * попыток чей бюджет получила.
 */
const HEADLESS_TIMEOUT_MS = 50;
const HEADED_TIMEOUT_MS = 120;

const FRAME_BEARER = 'bearer-из-кадра-аутентификации';
const STALE_HEADER_BEARER = 'bearer-протухший-первый';
const FRESH_HEADER_BEARER = 'bearer-свежий-последний';

const SOCKET_URL =
  'wss://cts01.clouds.org.ru/socket/user/websocket?key_id=key-id-1&instance_id=instance-id-1&vsn=1.0.0';

/**
 * Тела ключей синтетические и заведомо нерабочие: живое значение здесь ничего не доказало
 * бы, зато осталось бы в исходниках и в любом форке. Форма записи взята с фикстур
 * profileMaterial: узел лежит под произвольной обёрткой среза стора.
 */
const AUTH_STATE_ROWS: unknown[] = [
  { settings: { theme: 'dark' } },
  {
    persist: {
      version: 1,
      user: {
        privateKeys: {
          cts: { body: 'c2ludGV0aWNhLWN0cw==', publicKeyId: 'cts-public-key-id' },
          rts: { body: 'c2ludGV0aWNhLXJ0cw==', publicKeyId: 'rts-public-key-id' },
        },
        publicKeys: { cts: { body: 'c2ludGV0aWNhLXB1Yg==', id: 'cts-public-key-id' } },
        signKeys: {
          private: { body: 'c2ludGV0aWNhLXNpZ24=' },
          public: { id: 'sign-public-key-id' },
          keyType: 'ed25519',
        },
      },
    },
  },
];

const REDUX_PROFILES: unknown = {
  entities: [
    { isMe: false, userHuid: 'чужой-huid' },
    { isMe: true, userHuid: 'мой-huid' },
  ],
};

const PROFILE_COOKIES: ProfileCookie[] = [
  { name: 'ctsAuthToken', value: 'cookie-токен-сессии', domain: '.clouds.org.ru' },
  { name: 'sessionid', value: 'чужой', domain: '.example.com' },
];

/** Что подложный браузер показывает одной попытке: сессия, её отсутствие или падение навигации */
interface AttemptScenario {
  /** Заголовочные токены по порядку запросов: побеждать обязан последний */
  headerBearers?: string[];
  socketUrl?: string;
  authenticateToken?: string;
  cookies?: ProfileCookie[];
  authStateRows?: unknown[];
  profiles?: unknown;
  /** Навигация бросает: контекст обязан закрыться всё равно */
  navigationFails?: boolean;
}

/** Cookie и хранилища: они одинаковы везде, где профиль вообще заведён */
function profileStorage(): AttemptScenario {
  return { cookies: PROFILE_COOKIES, authStateRows: AUTH_STATE_ROWS, profiles: REDUX_PROFILES };
}

/** Профиль, в котором сессия есть целиком */
function sessionScenario(): AttemptScenario {
  return {
    headerBearers: [STALE_HEADER_BEARER, FRESH_HEADER_BEARER],
    socketUrl: SOCKET_URL,
    authenticateToken: FRAME_BEARER,
    ...profileStorage(),
  };
}

/** Тот же профиль, но сокет не прислал кадр аутентификации: остаются только заголовки */
function scenarioWithoutAuthenticateFrame(): AttemptScenario {
  return {
    headerBearers: [STALE_HEADER_BEARER, FRESH_HEADER_BEARER],
    socketUrl: SOCKET_URL,
    ...profileStorage(),
  };
}

/** Профиль без сессии: ни токена, ни сокета, ждать нечего до самого дедлайна */
function emptyScenario(): AttemptScenario {
  return profileStorage();
}

class FakeWebSocket implements ProfileWebSocket {
  private readonly frameListeners: ((frame: ProfileWebSocketFrame) => void)[] = [];

  constructor(private readonly socketUrl: string) {}

  url(): string {
    return this.socketUrl;
  }

  on(event: 'framesent', handler: (frame: ProfileWebSocketFrame) => void): void {
    if (event === 'framesent') {
      this.frameListeners.push(handler);
    }
  }

  send(payload: string): void {
    for (const listener of this.frameListeners) {
      listener({ payload });
    }
  }
}

class FakePage implements ProfilePage {
  private readonly requestListeners: ((request: ProfileRequest) => void)[] = [];
  private readonly socketListeners: ((socket: ProfileWebSocket) => void)[] = [];

  constructor(private readonly scenario: AttemptScenario) {}

  on(event: 'request', handler: (request: ProfileRequest) => void): void;
  on(event: 'websocket', handler: (socket: ProfileWebSocket) => void): void;
  on(
    event: 'request' | 'websocket',
    handler: ((request: ProfileRequest) => void) & ((socket: ProfileWebSocket) => void),
  ): void {
    if (event === 'request') {
      this.requestListeners.push(handler);
      return;
    }
    this.socketListeners.push(handler);
  }

  /**
   * Навигация это и есть момент жизни профиля: подписки уже расставлены, и подложная
   * страница отдаёт по ним ровно то, что живой клиент отдаёт за первые секунды вкладки.
   */
  async goto(url: string, options: { waitUntil: 'domcontentloaded' }): Promise<unknown> {
    if (this.scenario.navigationFails === true) {
      throw new Error(`навигация не удалась: ${url} (${options.waitUntil})`);
    }

    for (const bearer of this.scenario.headerBearers ?? []) {
      for (const listener of this.requestListeners) {
        listener({ headers: () => ({ authorization: `Bearer ${bearer}` }) });
      }
    }

    const { socketUrl, authenticateToken } = this.scenario;
    if (socketUrl !== undefined) {
      const socket = new FakeWebSocket(socketUrl);
      for (const listener of this.socketListeners) {
        listener(socket);
      }
      if (authenticateToken !== undefined) {
        socket.send(
          JSON.stringify({
            topic: 'phoenix',
            event: AUTHENTICATE_EVENT,
            payload: { token: authenticateToken },
            ref: 1,
          }),
        );
      }
    }

    return null;
  }

  /**
   * Разведение двух чтений профиля по содержимому скрипта: сами скрипты приватны, а имя
   * базы в их тексте это единственный признак, доступный снаружи.
   */
  async evaluate<Result>(script: string): Promise<Result> {
    if (script.includes('authState')) {
      return (this.scenario.authStateRows ?? []) as Result;
    }
    return (this.scenario.profiles ?? null) as Result;
  }
}

class FakeBrowserContext implements ProfileBrowserContext {
  closeCalls = 0;

  private readonly page: FakePage;

  constructor(private readonly scenario: AttemptScenario) {
    this.page = new FakePage(scenario);
  }

  pages(): ProfilePage[] {
    return [this.page];
  }

  async newPage(): Promise<ProfilePage> {
    return this.page;
  }

  async cookies(): Promise<ProfileCookie[]> {
    return this.scenario.cookies ?? [];
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

/** Подложный браузер: помнит каждый подъём и отдаёт свой сценарий headless и headed попытке */
class FakeBrowser {
  readonly launches: { headless: boolean; profileDir: string }[] = [];
  readonly contexts: FakeBrowserContext[] = [];

  constructor(private readonly scenarios: { headless: AttemptScenario; headed: AttemptScenario }) {}

  readonly launchContext: LaunchProfileContext = async ({ profileDir, headless }) => {
    this.launches.push({ headless, profileDir });
    const context = new FakeBrowserContext(headless ? this.scenarios.headless : this.scenarios.headed);
    this.contexts.push(context);
    return context;
  };

  get closeCalls(): number {
    return this.contexts.reduce((total, context) => total + context.closeCalls, 0);
  }
}

interface LogRecord {
  level: string;
  message: string;
  fields: LogFields | undefined;
}

function recordingLogger(records: LogRecord[]): Logger {
  const write =
    (level: string) =>
    (message: string, fields?: LogFields): void => {
      records.push({ level, message, fields });
    };
  return {
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    child: () => recordingLogger(records),
  };
}

function testConfig(): Config {
  return createTestConfig({
    auth: { headlessTimeoutMs: HEADLESS_TIMEOUT_MS, headedTimeoutMs: HEADED_TIMEOUT_MS },
  });
}

interface Harness {
  browser: FakeBrowser;
  config: Config;
  records: LogRecord[];
  source: PlaywrightProfileSource;
}

function harness(scenarios: { headless: AttemptScenario; headed: AttemptScenario }): Harness {
  const browser = new FakeBrowser(scenarios);
  const config = testConfig();
  const records: LogRecord[] = [];
  const source = new PlaywrightProfileSource({
    config,
    logger: recordingLogger(records),
    launchContext: browser.launchContext,
  });
  return { browser, config, records, source };
}

describe('headless-заход при живой сессии', () => {
  it('укладывается в один подъём профиля и собирает снимок целиком', async () => {
    const { browser, config, source } = harness({
      headless: sessionScenario(),
      headed: emptyScenario(),
    });

    const session = await source.load();

    expect(browser.launches).toEqual([{ headless: true, profileDir: config.paths.profileDir }]);
    /* Кадр аутентификации побеждает заголовок: сокет авторизуется уже после стартового рефреша */
    expect(session.bearer).toBe(FRAME_BEARER);
    expect(session.cookieHeader).toBe('ctsAuthToken=cookie-токен-сессии');
    expect(session.huid).toBe('мой-huid');
    expect(session.keyMaterial.wsParams).toEqual({ keyId: 'key-id-1', instanceId: 'instance-id-1' });
    expect(session.keyMaterial.signKeys.publicId).toBe('sign-public-key-id');
    expect(session.keyMaterial.privateKeys.cts?.publicKeyId).toBe('cts-public-key-id');
    expect(browser.closeCalls).toBe(1);
  });

  it('без кадра аутентификации берёт ПОСЛЕДНИЙ заголовочный токен, а не первый', async () => {
    const { browser, source } = harness({
      headless: scenarioWithoutAuthenticateFrame(),
      headed: emptyScenario(),
    });

    const session = await source.load();

    expect(session.bearer).toBe(FRESH_HEADER_BEARER);
    expect(session.bearer).not.toBe(STALE_HEADER_BEARER);
    expect(browser.launches).toHaveLength(1);
  });
});

describe('эскалация в окно браузера', () => {
  it('профиль без сессии поднимается второй раз с окном, и его сессия возвращается', async () => {
    const { browser, config, records, source } = harness({
      headless: emptyScenario(),
      headed: sessionScenario(),
    });

    const session = await source.load();

    expect(browser.launches.map((launch) => launch.headless)).toEqual([true, false]);
    expect(session.bearer).toBe(FRAME_BEARER);
    expect(browser.closeCalls).toBe(2);

    const warning = records.find((record) => record.level === 'warn');
    expect(warning?.message).toContain('откроется окно браузера для ручного входа');
    expect(warning?.fields).toMatchObject({
      profileDir: config.paths.profileDir,
      waitMs: HEADED_TIMEOUT_MS,
    });
  });

  it('провал обеих попыток это отказ авторизации с причинами обеих', async () => {
    const { browser, source } = harness({ headless: emptyScenario(), headed: emptyScenario() });

    const failure = await source.load().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AuthError);
    const error = failure as AuthError;
    expect(error.kind).toBe('bearer');
    /* Бюджеты в тексте разные: так видно, что вторая попытка получила именно headed-бюджет */
    expect(error.message).toContain(`Headless: сессия не стабилизировалась за ${HEADLESS_TIMEOUT_MS} мс`);
    expect(error.message).toContain(`С окном: сессия не стабилизировалась за ${HEADED_TIMEOUT_MS} мс`);
    /* Отказ не оставляет за собой открытых профилей: следующий подъём упёрся бы в singleton-lock */
    expect(browser.contexts.map((context) => context.closeCalls)).toEqual([1, 1]);
  });
});

describe('контекст браузера закрывается всегда', () => {
  it('и после попытки, где навигация бросила, и после успешной', async () => {
    const { browser, source } = harness({
      headless: { ...emptyScenario(), navigationFails: true },
      headed: sessionScenario(),
    });

    const session = await source.load();

    expect(session.bearer).toBe(FRAME_BEARER);
    expect(browser.contexts.map((context) => context.closeCalls)).toEqual([1, 1]);
  });
});

describe('второй запуск не требует ручного входа', () => {
  it('кэш отдаёт снимок без подъёма, а обновление поднимает профиль заново', async () => {
    const { browser, config, records, source } = harness({
      headless: sessionScenario(),
      headed: emptyScenario(),
    });
    const auth = new PlaywrightProfileAuth({ config, logger: recordingLogger(records), source });

    expect(await auth.getBearer()).toBe(FRAME_BEARER);
    expect(await auth.getCookieHeader()).toBe('ctsAuthToken=cookie-токен-сессии');
    expect(await auth.getWhoami()).toEqual({ huid: 'мой-huid' });
    expect(browser.launches).toHaveLength(1);

    expect(await auth.getBearer(true)).toBe(FRAME_BEARER);

    expect(browser.launches).toHaveLength(2);
    /* Оба подъёма headless: окно с ручным входом второй раз не понадобилось */
    expect(browser.launches.every((launch) => launch.headless)).toBe(true);
    expect(browser.closeCalls).toBe(2);
  });
});
