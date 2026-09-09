/**
 * Список тредов: форма запроса, форма элемента и поиск треда в чате.
 *
 * Форма элемента взята с живой пробы (findings.md, P4; p45-result.json), поэтому фикстура
 * повторяет её целиком, включая поля, которые наружу не уходят: разбор обязан их пережить,
 * а не спотыкаться о лишнее.
 *
 * Подложный сервер здесь СОЗНАТЕЛЬНО не понимает сужения по чату: живая проба спрашивала
 * список только целиком, и код обязан выдерживать сервер, который на суженный запрос
 * отвечает пустотой. Если бы подложный сервер сразу отвечал удобно, проверка доказывала бы
 * только саму себя.
 */
import { describe, expect, it } from 'vitest';
import type { AuthProvider } from '../../src/auth/AuthProvider.js';
import type { KeyStore } from '../../src/auth/keyStore.js';
import type { CryptoService } from '../../src/crypto/types.js';
import { getThread } from '../../src/mcp/tools/getThread.js';
import type { ToolDeps } from '../../src/mcp/tools/deps.js';
import {
  THREAD_LIST_EVENT,
  fetchThreadList,
  findThread,
  normalizeThread,
} from '../../src/protocol/threads.js';
import type { RestClient } from '../../src/transport/types.js';
import type { PhoenixClient } from '../../src/transport/ws/types.js';
import { createLogger } from '../../src/util/logger.js';
import { OTHER_CHAT_ID, POLYGON_CHAT_ID } from '../helpers/readFixtures.js';
import { createTestConfig } from '../helpers/testConfig.js';

const THREAD_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_THREAD_ID = '22222222-2222-4222-8222-222222222222';

interface RecordedCall {
  topic: string;
  event: string;
  payload: Record<string, unknown>;
}

function forbidden(what: string): () => never {
  return () => {
    throw new Error(`${what}: этот путь в проверке не участвует`);
  };
}

/** Элемент списка тредов ровно в той форме, в какой он снят живой пробой */
function rawThread(threadId: string, chatId: string): Record<string, unknown> {
  return {
    thread_id: threadId,
    group_chat_id: chatId,
    counter: 3,
    keys: ['recipient-key-id-a'],
    chat_settings: { reactions: { available_reactions: null, reactions_enabled: null } },
    active: true,
    inserted_at: '2026-09-01T07:00:00.000000Z',
    updated_at: '2026-09-08T07:05:00.000000Z',
    last_event_sync_id: '00000000-0000-4000-8000-000000000009',
    last_event_inserted_at: '2026-09-08T07:04:00.000000Z',
    message_pinned_at: null,
    message_pinned_by: null,
    message_pinned_sync_id: null,
    position_event_inserted_at: null,
    position_event_sync_id: null,
    read_position_at: '2026-09-08T07:04:30.000000Z',
    received_position_at: '2026-09-08T07:04:30.000000Z',
    sorting_inserted_at: '2026-09-08T07:04:00.000000Z',
    sorting_sync_id: '00000000-0000-4000-8000-000000000009',
  };
}

type Responder = (call: RecordedCall) => unknown;

function createDeps(responder: Responder): { deps: ToolDeps; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const ws: PhoenixClient = {
    request: (async (topic: string, event: string, payload: unknown) => {
      const call: RecordedCall = { topic, event, payload: payload as Record<string, unknown> };
      calls.push(call);
      return responder(call);
    }) as PhoenixClient['request'],
    close: async () => undefined,
  };
  const crypto: CryptoService = {
    keys: {
      senderPublicKey: forbidden('crypto.keys.senderPublicKey'),
      resolveRecipientPublicKeys: forbidden('crypto.keys.resolveRecipientPublicKeys'),
    },
    decryptEvent: forbidden('crypto.decryptEvent'),
    encryptMessage: forbidden('crypto.encryptMessage'),
  };
  const keyStore: KeyStore = {
    match: forbidden('keyStore.match'),
    require: forbidden('keyStore.require'),
  };
  const rest: RestClient = {
    getJson: forbidden('rest.getJson'),
    postJson: forbidden('rest.postJson'),
    getKdcKeys: forbidden('rest.getKdcKeys'),
  };
  const auth: AuthProvider = {
    getBearer: forbidden('auth.getBearer'),
    getCookieHeader: forbidden('auth.getCookieHeader'),
    getWhoami: forbidden('auth.getWhoami'),
    getKeyMaterial: forbidden('auth.getKeyMaterial'),
    onAuthFailure: forbidden('auth.onAuthFailure'),
  };
  return {
    deps: {
      ws,
      rest,
      auth,
      crypto,
      keyStore,
      config: createTestConfig(),
      logger: createLogger({ level: 'error' }),
    },
    calls,
  };
}

/** Сервер, который сужение по чату НЕ понимает: на запрос с чатом отдаёт пустоту */
function narrowingBlindServer(threads: Record<string, unknown>[]): Responder {
  return (call) => {
    const requested = call.payload['group_chat_id'];
    return { [THREAD_LIST_EVENT]: requested === null ? threads : [] };
  };
}

describe('normalizeThread', () => {
  it('снимает с живой формы адрес треда, родительский чат и метки', () => {
    expect(normalizeThread(rawThread(THREAD_ID, POLYGON_CHAT_ID))).toEqual({
      thread_id: THREAD_ID,
      chat_id: POLYGON_CHAT_ID,
      unread_count: 3,
      last_message_id: '00000000-0000-4000-8000-000000000009',
      last_activity: '2026-09-08T07:04:00.000Z',
    });
  });

  it('запись без адреса треда или без родительского чата не нормализуется', () => {
    expect(normalizeThread({ group_chat_id: POLYGON_CHAT_ID })).toBeUndefined();
    expect(normalizeThread({ thread_id: THREAD_ID })).toBeUndefined();
    expect(normalizeThread('не объект')).toBeUndefined();
  });

  it('ключевой материал треда наружу не уходит', () => {
    const record = normalizeThread(rawThread(THREAD_ID, POLYGON_CHAT_ID));

    expect(JSON.stringify(record)).not.toContain('recipient-key-id-a');
  });
});

describe('fetchThreadList', () => {
  it('спрашивает весь список кадром, снятым живьём', async () => {
    const { deps, calls } = createDeps(() => ({ [THREAD_LIST_EVENT]: [] }));

    await fetchThreadList(deps);

    expect(calls[0]?.topic).toBe('system');
    expect(calls[0]?.event).toBe(THREAD_LIST_EVENT);
    expect(calls[0]?.payload).toEqual({
      group_chat_id: null,
      since: '1970-01-01T00:00:00.000000Z',
      request_version: createTestConfig().protocol.threadListRequestVersion,
    });
  });

  it('сужение по чату подставляет идентификатор вместо пустого значения', async () => {
    const { deps, calls } = createDeps(() => ({ [THREAD_LIST_EVENT]: [] }));

    await fetchThreadList(deps, POLYGON_CHAT_ID);

    expect(calls[0]?.payload['group_chat_id']).toBe(POLYGON_CHAT_ID);
  });

  it('читает конверт под обоими известными именами и роняет только неадресуемые записи', async () => {
    const { deps } = createDeps(() => ({
      threads: [rawThread(THREAD_ID, POLYGON_CHAT_ID), { counter: 1 }],
    }));

    const threads = await fetchThreadList(deps);

    expect(threads.map((thread) => thread.thread_id)).toEqual([THREAD_ID]);
  });
});

describe('findThread', () => {
  it('находит тред суженным запросом, когда сервер сужение понимает', async () => {
    const { deps, calls } = createDeps(() => ({
      [THREAD_LIST_EVENT]: [rawThread(THREAD_ID, POLYGON_CHAT_ID)],
    }));

    const found = await findThread(deps, { chatId: POLYGON_CHAT_ID, threadId: THREAD_ID });

    expect(found?.thread_id).toBe(THREAD_ID);
    expect(calls).toHaveLength(1);
  });

  it('пустой ответ на суженный запрос переспрашивается полным списком', async () => {
    const { deps, calls } = createDeps(
      narrowingBlindServer([rawThread(THREAD_ID, POLYGON_CHAT_ID)]),
    );

    const found = await findThread(deps, { chatId: POLYGON_CHAT_ID, threadId: THREAD_ID });

    expect(found?.chat_id).toBe(POLYGON_CHAT_ID);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.payload['group_chat_id']).toBeNull();
  });

  it('тред чужого чата своим не считается, даже если сервер отдал его в общем списке', async () => {
    const { deps } = createDeps(narrowingBlindServer([rawThread(OTHER_THREAD_ID, OTHER_CHAT_ID)]));

    const found = await findThread(deps, { chatId: POLYGON_CHAT_ID, threadId: OTHER_THREAD_ID });

    expect(found).toBeUndefined();
  });
});

describe('get_thread: разбор входа', () => {
  it('без thread_id и без message_id вызов не идёт к серверу вовсе', async () => {
    const { deps, calls } = createDeps(forbidden('ws.request'));

    const result = await getThread(deps, { chat: POLYGON_CHAT_ID });

    expect(result.status).toBe('invalid_input');
    expect(result.status === 'invalid_input' && result.next_step).toContain('thread_id');
    expect(calls).toHaveLength(0);
  });
});
