/**
 * PhoenixWsClient против локального Phoenix-мока: настоящий сокет, настоящий хендшейк,
 * настоящие кадры, подменён только адрес.
 *
 * Таймауты в конфиге теста маленькие намеренно: сценарии молчания и обрыва обязаны
 * проверяться реальным временем (иначе они не докажут ничего про живой сокет), но время
 * это должно измеряться десятками миллисекунд, а не секундами.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthError } from '../../src/auth/AuthProvider.js';
import type { WsConfig } from '../../src/config/types.js';
import { PhoenixReplyError, PhoenixWsClient, WsClosedError } from '../../src/transport/ws/PhoenixClient.js';
import type { PhoenixFrame } from '../../src/transport/ws/frames.js';
import { FakeAuth } from '../helpers/fakeAuth.js';
import { MockPhoenix, startMockPhoenix } from '../helpers/mockPhoenix.js';
import { createTestConfig } from '../helpers/testConfig.js';

let mock: MockPhoenix;
let auth: FakeAuth;
let client: PhoenixWsClient;

function createClient(ws: Partial<WsConfig> = {}): PhoenixWsClient {
  return new PhoenixWsClient({
    auth,
    config: createTestConfig({
      protocol: { wsUrl: mock.url },
      ws: {
        authenticateTimeoutMs: 150,
        authenticateAttempts: 2,
        requestTimeoutMs: 400,
        reconnectAttempts: 3,
        reconnectBaseDelayMs: 10,
        reconnectMaxDelayMs: 40,
        /* Heartbeat в тестах не нужен: он только расходовал бы ref и путал проверки */
        heartbeatIntervalMs: 60_000,
        /* Закрытие по простою выключено везде, кроме набора, который его и проверяет */
        idleCloseMs: 0,
        ...ws,
      },
    }),
  });
}

/** Ждёт наступления факта, а не фиксированную паузу: закрытие сокета асинхронно */
async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
}

beforeEach(async () => {
  mock = await startMockPhoenix();
  auth = new FakeAuth();
  client = createClient();
});

afterEach(async () => {
  await client.close();
  await mock.close();
});

describe('хендшейк', () => {
  it('несёт query живого клиента в том же порядке', async () => {
    await client.connect();

    const query = mock.latest.url.split('?')[1] ?? '';
    const names = query.split('&').map((part) => part.split('=')[0]);
    const values = new URLSearchParams(query);

    expect(names).toEqual(['vsn', 'auto_join', 'key_id', 'version', 'background', 'instance_id']);
    expect(values.get('vsn')).toBe('1.0.0');
    expect(values.get('auto_join')).toBe('true');
    expect(values.get('key_id')).toBe(auth.keyId);
    expect(values.get('version')).toBe('6');
    expect(values.get('background')).toBe('false');
    expect(values.get('instance_id')).toBe(auth.instanceId);
  });

  it('несёт Origin, Cookie и User-Agent заголовками, а не параметрами URL', async () => {
    await client.connect();

    expect(mock.latest.headers.origin).toBe('https://clouds.org.ru');
    expect(mock.latest.headers.cookie).toBe(auth.cookieHeader);
    expect(mock.latest.headers['user-agent']).toContain('Mozilla/5.0');
    expect(mock.latest.url).not.toContain('bearer');
  });
});

describe('authenticate', () => {
  it('шлёт bearer первым кадром в топик phoenix', async () => {
    await client.connect();

    const frames = mock.framesOf('authenticate');
    expect(frames).toHaveLength(1);
    expect(frames[0]?.topic).toBe('phoenix');
    expect(frames[0]?.ref).toBe(0);
    expect(frames[0]?.payload).toEqual({ token: 'bearer-1' });
  });

  /* Живое наблюдение: первый authenticate иногда остаётся без ответа, лечится повтором кадра */
  it('на молчание сервера шлёт кадр повторно с новым ref и авторизуется', async () => {
    mock.silentOnAuthenticate(1);

    await client.connect();

    const frames = mock.framesOf('authenticate');
    expect(frames).toHaveLength(2);
    expect(frames[0]?.ref).not.toBe(frames[1]?.ref);
    /* Повтор идёт по тому же соединению: сокет жив, молчал только ответ */
    expect(mock.connections).toHaveLength(1);
  });

  it('исчерпав попытки, отдаёт AuthError протокола, а не бесконечно ждёт', async () => {
    mock.silentOnAuthenticate(5);

    const error = (await client.connect().catch((caught: unknown) => caught)) as AuthError;

    expect(error).toBeInstanceOf(AuthError);
    expect(error.kind).toBe('protocol');
    expect(mock.framesOf('authenticate')).toHaveLength(2);
  });

  it('на отказ сервера сбрасывает кэш авторизации и подключается заново с новым bearer', async () => {
    mock.rejectAuthenticate('invalid_token');

    await client.connect();

    expect(auth.calls.onAuthFailure).toBe(1);
    expect(mock.connections).toHaveLength(2);
    const frames = mock.framesOf('authenticate');
    expect(frames[0]?.payload).toEqual({ token: 'bearer-1' });
    expect(frames[1]?.payload).toEqual({ token: 'bearer-2' });
  });

  /* Отказ хендшейка приходит до апгрейда: это тот же протухший bearer, только раньше */
  it('на HTTP 401 хендшейка сбрасывает кэш авторизации и повторяет один раз', async () => {
    mock.rejectHandshake(401);

    await client.connect();

    expect(auth.calls.onAuthFailure).toBe(1);
    expect(mock.connections).toHaveLength(1);
    expect(mock.framesOf('authenticate')[0]?.payload).toEqual({ token: 'bearer-2' });
  });

  it('второй подряд отказ хендшейка отдаёт AuthError наружу', async () => {
    mock.rejectHandshake(401, 2);

    const error = (await client.connect().catch((caught: unknown) => caught)) as AuthError;

    expect(error).toBeInstanceOf(AuthError);
    expect(error.kind).toBe('bearer');
    expect(auth.calls.onAuthFailure).toBe(1);
  });
});

describe('корреляция ответов', () => {
  it('два параллельных запроса получают каждый свой ответ по ref', async () => {
    mock.respondTo('read', (frame) => ({
      status: 'ok',
      response: { echo: (frame.payload as { value: string }).value, ref: frame.ref },
    }));

    const [first, second] = await Promise.all([
      client.request<{ echo: string; ref: number }>('system', 'read', { value: 'первый' }),
      client.request<{ echo: string; ref: number }>('system', 'read', { value: 'второй' }),
    ]);

    expect(first.echo).toBe('первый');
    expect(second.echo).toBe('второй');
    expect(first.ref).not.toBe(second.ref);
  });

  /*
   * После переподключения ref начинается заново, поэтому номера неизбежно повторяются.
   * Ожидания живут на объекте соединения, и ответ нового соединения обязан достаться
   * новому запросу, а старый запрос обязан остаться отклонённым.
   */
  it('переиспользование ref после переподключения не путает ответы', async () => {
    let seen = 0;
    mock.respondTo('read', () => {
      seen += 1;
      if (seen === 1) {
        mock.dropAll();
        return undefined;
      }
      return { status: 'ok', response: { value: 'второй' } };
    });

    const first = client.request('system', 'read', { value: 'первый' }, { retry: false });
    await expect(first).rejects.toBeInstanceOf(WsClosedError);

    const second = await client.request<{ value: string }>('system', 'read', { value: 'второй' });

    expect(second).toEqual({ value: 'второй' });
    const frames = mock.framesOf('read');
    expect(frames).toHaveLength(2);
    expect(frames[0]?.ref).toBe(frames[1]?.ref);
    expect(mock.connections).toHaveLength(2);
  });
});

describe('обрыв и повтор', () => {
  it('запрос чтения переживает обрыв: клиент переподключается и доводит запрос', async () => {
    let seen = 0;
    mock.respondTo('get_chat_list_base_changes', () => {
      seen += 1;
      if (seen === 1) {
        mock.dropAll();
        return undefined;
      }
      return { status: 'ok', response: { chats: [] } };
    });

    const result = await client.request<{ chats: unknown[] }>('system', 'get_chat_list_base_changes', {
      since: '1970-01-01T00:00:00.000000Z',
      request_version: 6,
    });

    expect(result).toEqual({ chats: [] });
    expect(mock.connections).toHaveLength(2);
  });

  it('исчерпав бюджет переподключений, отдаёт ошибку наружу', async () => {
    /* Сервер убран совсем: каждое подключение обречено, бюджет тратится и заканчивается */
    await mock.close();

    await expect(client.request('system', 'read', {})).rejects.toBeInstanceOf(Error);
  });

  /*
   * Отправка необратима: сервер мог принять кадр и не успеть ответить, поэтому повтор
   * задвоил бы сообщение. Проверяется по ВСЕМ соединениям, иначе реконнект спрятал бы повтор.
   */
  it('запрос с retry false не повторяется после обрыва: ровно один кадр по всем соединениям', async () => {
    mock.respondTo('message_new', () => {
      mock.dropAll();
      return undefined;
    });

    await expect(
      client.request('groupchat:group-id', 'message_new', { sync_id: 'sync-id' }, { retry: false }),
    ).rejects.toBeInstanceOf(WsClosedError);

    expect(mock.framesOf('message_new')).toHaveLength(1);
    expect(mock.connections).toHaveLength(1);
  });

  it('запрос с retry false не повторяется и по таймауту', async () => {
    mock.respondTo('message_new', () => undefined);

    await expect(
      client.request('groupchat:group-id', 'message_new', { sync_id: 'sync-id' }, { retry: false, timeoutMs: 80 }),
    ).rejects.toThrow(/не пришёл/);

    expect(mock.framesOf('message_new')).toHaveLength(1);
  });
});

/**
 * Простой. Открытый сокет это заявление о присутствии: пока он жив, мессенджер показывает
 * владельца сессии в сети. Интервалы здесь десятки миллисекунд, но время настоящее:
 * подменённый таймер доказал бы вызов планировщика, а доказать надо закрытие сокета,
 * которое видит вторая сторона, и подъём нового соединения со своим authenticate.
 */
describe('простой', () => {
  const IDLE_CLOSE_MS = 150;

  it('закрывает соединение сам, когда запросов больше нет', async () => {
    client = createClient({ idleCloseMs: IDLE_CLOSE_MS });
    mock.respondTo('read', () => ({ status: 'ok', response: { value: 'ответ' } }));

    await client.request('system', 'read', {});
    const connection = mock.latest;

    expect(await waitFor(() => connection.closed)).toBe(true);
    /* Закрытие штатное, а не обрыв с переподключением: взамен никто ничего не поднимал */
    expect(mock.connections).toHaveLength(1);
  });

  it('следующий запрос поднимает новое соединение и снова авторизует его', async () => {
    client = createClient({ idleCloseMs: IDLE_CLOSE_MS });
    mock.respondTo('read', () => ({ status: 'ok', response: { value: 'ответ' } }));

    await client.request('system', 'read', {});
    expect(await waitFor(() => mock.latest.closed)).toBe(true);

    await expect(client.request('system', 'read', {})).resolves.toEqual({ value: 'ответ' });

    expect(mock.connections).toHaveLength(2);
    /* Соединение поднято с нуля: первым кадром снова authenticate, и ref начат заново */
    const second = mock.connections[1];
    expect(second?.frames[0]?.event).toBe('authenticate');
    expect(second?.frames[0]?.ref).toBe(0);
    expect(second?.closed).toBe(false);
  });

  it('запрос в полёте переносит закрытие: ответ дольше простоя не теряется', async () => {
    client = createClient({ idleCloseMs: IDLE_CLOSE_MS });
    mock.respondTo('read', (frame, connection) => {
      setTimeout(() => {
        mock.reply(connection, frame, { status: 'ok', response: { value: 'ответ' } });
      }, IDLE_CLOSE_MS + 100);
      return undefined;
    });

    await expect(client.request('system', 'read', {})).resolves.toEqual({ value: 'ответ' });

    expect(mock.connections).toHaveLength(1);
    expect(mock.latest.closed).toBe(false);
  });

  it('ноль выключает авто-закрытие: соединение переживает несколько интервалов', async () => {
    const idleBaseMs = 50;
    client = createClient({ idleCloseMs: 0 });

    await client.connect();
    const connection = mock.latest;
    await new Promise((resolve) => setTimeout(resolve, idleBaseMs * 4));

    expect(connection.closed).toBe(false);
    expect(mock.connections).toHaveLength(1);
  });
});

/**
 * Лимит частоты. Пауза здесь настоящая и не может быть короче секунды по построению
 * (единица `retry_after` не установлена, и зажим снизу это защита от ретрай-шторма).
 * Секунда в прогоне куплена сознательно: подменённый таймер доказал бы вызов `sleep`,
 * но не то, что клиент действительно ждёт, прежде чем снова дёрнуть сервер.
 */
describe('лимит частоты', () => {
  it('чтение выдерживает паузу и повторяется по тому же соединению', async () => {
    let seen = 0;
    mock.respondTo('read', () => {
      seen += 1;
      return seen === 1
        ? { status: 'error', response: { error: 'rate_limited', retry_after: 1 } }
        : { status: 'ok', response: { value: 'ответ' } };
    });

    const startedAt = Date.now();
    const result = await client.request<{ value: string }>('system', 'read', {});

    expect(result).toEqual({ value: 'ответ' });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
    expect(mock.framesOf('read')).toHaveLength(2);
    /* Просьба подождать не является обрывом: сокет остаётся тот же */
    expect(mock.connections).toHaveLength(1);
  });

  /*
   * Отправка необратима, и пауза этого не меняет: сервер мог принять кадр и отказать уже
   * после приёма. Поэтому просьба подождать уходит наружу кодом, а ждать решает вызывающий.
   */
  it('запрос с retry false не ждёт и не повторяется: ровно один кадр по всем соединениям', async () => {
    mock.respondTo('message_new', () => ({
      status: 'error',
      response: { error: 'rate_limited', retry_after: 1 },
    }));

    const startedAt = Date.now();
    const error = (await client
      .request('groupchat:group-id', 'message_new', { sync_id: 'sync-id' }, { retry: false })
      .catch((caught: unknown) => caught)) as PhoenixReplyError;

    expect(error).toBeInstanceOf(PhoenixReplyError);
    expect(error.code).toBe('rate_limited');
    expect(Date.now() - startedAt).toBeLessThan(900);
    expect(mock.framesOf('message_new')).toHaveLength(1);
    expect(mock.connections).toHaveLength(1);
  });

  /* Прочий прикладной отказ повтором не лечится и после появления паузы: он вернётся тем же */
  it('обычный отказ сервера не превращается в паузу даже для чтения', async () => {
    mock.respondTo('read', () => ({ status: 'error', response: { error: 'invalid_keys' } }));

    const startedAt = Date.now();
    await expect(client.request('system', 'read', {})).rejects.toBeInstanceOf(PhoenixReplyError);

    expect(Date.now() - startedAt).toBeLessThan(900);
    expect(mock.framesOf('read')).toHaveLength(1);
  });
});

describe('кадры сервера', () => {
  it('событие без ref доходит до слушателя и не ломает корреляцию', async () => {
    const received: PhoenixFrame[] = [];
    client.onEvent((frame) => received.push(frame));
    mock.respondTo('read', () => ({ status: 'ok', response: { value: 'ответ' } }));

    await client.connect();
    mock.sendServerEvent(mock.latest, 'system', 'app_event', { sync_id: 'sync-id', version: 1 });
    await waitFor(() => received.length > 0);

    expect(received).toHaveLength(1);
    expect(received[0]?.event).toBe('app_event');
    expect(received[0]?.ref).toBeNull();

    /* Клиент остался рабочим: запрос после кадра сервера проходит как обычно */
    await expect(client.request('system', 'read', {})).resolves.toEqual({ value: 'ответ' });
  });
});
