/**
 * Инструменты чтения от кадра до выдачи MCP.
 *
 * Настоящими здесь являются все слои, кроме двух подмен: адрес сокета ведёт в локальный
 * Phoenix-мок, а KDC отвечает подложным fetch. Всё остальное это боевой код: клиент сокета,
 * REST-клиент, libsodium, хранилище ключей, разбор форм и регистрация инструментов. Ради
 * этого проверка и заведена: расшифровка на подложном крипто доказывала бы только то, что
 * подложное крипто работает.
 *
 * Подложный сервер отдаёт страницу от новых к старым и ВКЛЮЧАЕТ событие курсора: живьём ни
 * порядок, ни включающая семантика курсора не установлены, и код обязан выдерживать
 * неудобную для себя трактовку.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import sodium from 'libsodium-wrappers-sumo';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { KeyMaterial } from '../../src/auth/AuthProvider.js';
import { FakeAuthProvider, createFakeKeyMaterial } from '../../src/auth/FakeAuthProvider.js';
import { AuthKeyStore } from '../../src/auth/keyStore.js';
import { SodiumCryptoService } from '../../src/crypto/service.js';
import type { GetHistoryResult } from '../../src/mcp/tools/getHistory.js';
import type { GetMessageResult } from '../../src/mcp/tools/getMessage.js';
import type { GetMessageContextResult } from '../../src/mcp/tools/getMessageContext.js';
import type { ListChatsResult } from '../../src/mcp/tools/listChats.js';
import {
  CHAT_LIST_EVENT,
  CHAT_LIST_SINCE_EPOCH,
  SYSTEM_TOPIC,
  UNREAD_COUNTERS_EVENT,
} from '../../src/protocol/chatList.js';
import { EVENT_INFO_EVENT } from '../../src/protocol/eventInfo.js';
import { EVENTS_HISTORY_EVENT } from '../../src/protocol/history.js';
import { TOOL_NAMES, createServer } from '../../src/server.js';
import { HttpRestClient } from '../../src/transport/RestClient.js';
import { PhoenixWsClient } from '../../src/transport/ws/PhoenixClient.js';
import { createLogger } from '../../src/util/logger.js';
import { makeKeyRing, type KeyRing } from '../helpers/cryptoFixtures.js';
import { MockPhoenix, startMockPhoenix } from '../helpers/mockPhoenix.js';
import {
  MY_HUID,
  OTHER_CHAT_ID,
  POLYGON_CHAT_ID,
  makeHistoryEvent,
  makeInnerImage,
  makeInnerText,
  makeRawChat,
} from '../helpers/readFixtures.js';
import { createTestConfig } from '../helpers/testConfig.js';

const THIRD_CHAT_ID = '7f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
/** Инструменты, зарегистрированные на сегодня: девять читающих плюс двухшаговая отправка */
const REGISTERED_TOOLS = [
  'list_chats',
  'get_history',
  'get_message',
  'get_message_context',
  'get_thread',
  'list_reactions',
  'get_poll',
  'download_attachment',
  'search',
  'send_message',
];

function syncId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`;
}

function eventTime(index: number): string {
  return `2026-09-08T07:0${index}:00.000Z`;
}

let ring: KeyRing;
let mock: MockPhoenix;
let ws: PhoenixWsClient;
let server: McpServer;
let client: Client;
let historyEvents: Record<string, unknown>[];
/** Переключатели подложного сервера: ими проверяются оба пути чтения и путь отказа */
let eventInfoRejects: boolean;
let historyRejects: boolean;

const CHATS = [
  makeRawChat({
    chatId: POLYGON_CHAT_ID,
    name: 'Избранное',
    chatType: 'notes',
    updatedAt: '2026-09-08T07:05:00.000000Z',
  }),
  makeRawChat({
    chatId: OTHER_CHAT_ID,
    name: 'Дежурка',
    chatType: 'group_chat',
    updatedAt: '2026-09-07T07:00:00.000000Z',
  }),
  makeRawChat({
    chatId: THIRD_CHAT_ID,
    name: 'Дежурка резерв',
    chatType: 'group_chat',
    updatedAt: '2026-09-06T07:00:00.000000Z',
  }),
];

async function buildHistory(): Promise<Record<string, unknown>[]> {
  const common = {
    groupChatId: POLYGON_CHAT_ID,
    sender: MY_HUID,
    senderKeyId: ring.sender.keyId,
    senderPrivateKey: ring.sender.privateKey,
    recipient: ring.recipients[0],
  };
  return [
    await makeHistoryEvent({
      ...common,
      syncId: syncId(1),
      insertedAt: eventTime(1),
      inner: makeInnerText({
        msgId: syncId(1),
        from: MY_HUID,
        timestamp: eventTime(1),
        groupChatId: POLYGON_CHAT_ID,
        body: 'первое сообщение',
      }),
    }),
    await makeHistoryEvent({
      ...common,
      syncId: syncId(2),
      insertedAt: eventTime(2),
      inner: makeInnerText({
        msgId: syncId(2),
        from: MY_HUID,
        timestamp: eventTime(2),
        groupChatId: POLYGON_CHAT_ID,
        body: 'второе сообщение',
      }),
    }),
    await makeHistoryEvent({
      ...common,
      syncId: syncId(3),
      insertedAt: eventTime(3),
      readByCount: 2,
      inner: makeInnerImage({
        msgId: syncId(3),
        from: MY_HUID,
        timestamp: eventTime(3),
        groupChatId: POLYGON_CHAT_ID,
        fileId: 'c0ffee00-0000-4000-8000-000000000001',
        fileName: 'снимок.png',
      }),
    }),
    await makeHistoryEvent({
      ...common,
      syncId: syncId(4),
      insertedAt: eventTime(4),
      reactionCounters: '✅:1',
      myReactions: ['✅'],
      inner: makeInnerText({
        msgId: syncId(4),
        from: MY_HUID,
        timestamp: eventTime(4),
        groupChatId: POLYGON_CHAT_ID,
        body: 'четвёртое сообщение',
      }),
    }),
    await makeHistoryEvent({
      ...common,
      syncId: syncId(5),
      insertedAt: eventTime(5),
      inner: makeInnerText({
        msgId: syncId(5),
        from: MY_HUID,
        timestamp: eventTime(5),
        groupChatId: POLYGON_CHAT_ID,
        body: 'пятое сообщение',
      }),
    }),
  ];
}

function historyPage(payload: Record<string, unknown>): unknown {
  if (payload['group_chat_id'] !== POLYGON_CHAT_ID) {
    return { history: [] };
  }
  const cursor = payload['sync_id'];
  const limit = payload['limit'] as number;
  const direction = payload['direction'];
  let pool = [...historyEvents];
  if (typeof cursor === 'string') {
    const at = pool.findIndex((event) => event['sync_id'] === cursor);
    if (at >= 0) {
      pool = direction === 'forward' ? pool.slice(at) : pool.slice(0, at + 1);
    }
  }
  const slice = direction === 'forward' ? pool.slice(0, limit) : pool.slice(-limit);
  return { history: [...slice].reverse() };
}

/** KDC отдаёт публичную половину отправителя: без неё обёртка контент-ключа не открывается */
function kdcFetch(): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        result: [
          {
            key_id: ring.sender.keyId,
            algo: 'x25519',
            kind: 'cts',
            body: sodium.to_base64(ring.sender.publicKey, sodium.base64_variants.ORIGINAL),
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;
}

function keyMaterialForRing(): KeyMaterial {
  const base = createFakeKeyMaterial();
  return {
    /* Получатель события это мой cts-ключ: именно его ищет хранилище по key_id конверта */
    privateKeys: { cts: ring.recipients[0].privateKeyEntry },
    signKeys: base.signKeys,
    wsParams: { keyId: ring.recipients[0].keyId, instanceId: 'test-instance-id' },
  };
}

async function callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  if (result.isError === true) {
    throw new Error(`инструмент ${name} ответил ошибкой: ${content[0]?.text ?? ''}`);
  }
  return JSON.parse(content[0]?.text ?? 'null') as T;
}

async function callToolExpectingError(name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  expect(result.isError).toBe(true);
  return content[0]?.text ?? '';
}

beforeAll(async () => {
  await sodium.ready;
  ring = await makeKeyRing();
});

beforeEach(async () => {
  eventInfoRejects = false;
  historyRejects = false;
  historyEvents = await buildHistory();
  mock = await startMockPhoenix();

  mock.respondTo(CHAT_LIST_EVENT, () => ({ status: 'ok', response: { [CHAT_LIST_EVENT]: CHATS } }));
  mock.respondTo(UNREAD_COUNTERS_EVENT, () => ({
    status: 'ok',
    response: {
      unread_counters: [
        { counter: 0, group_chat_id: POLYGON_CHAT_ID },
        { counter: 4, group_chat_id: OTHER_CHAT_ID },
      ],
    },
  }));
  mock.respondTo(EVENT_INFO_EVENT, (frame) => {
    if (eventInfoRejects) {
      return { status: 'error', response: { error: 'unknown_event' } };
    }
    const payload = frame.payload as Record<string, unknown>;
    const requested = payload['sync_ids'] as string[];
    return {
      status: 'ok',
      response: {
        [EVENT_INFO_EVENT]: historyEvents.filter((event) =>
          requested.includes(event['sync_id'] as string),
        ),
      },
    };
  });
  mock.respondTo(EVENTS_HISTORY_EVENT, (frame) =>
    historyRejects
      ? { status: 'error', response: { error: 'invalid_keys' } }
      : { status: 'ok', response: historyPage(frame.payload as Record<string, unknown>) },
  );

  const logger = createLogger({ level: 'error' });
  const config = createTestConfig({
    protocol: { wsUrl: mock.url },
    ws: {
      authenticateTimeoutMs: 300,
      authenticateAttempts: 2,
      requestTimeoutMs: 1_000,
      reconnectAttempts: 2,
      reconnectBaseDelayMs: 10,
      reconnectMaxDelayMs: 40,
      heartbeatIntervalMs: 60_000,
    },
  });
  const auth = new FakeAuthProvider({ keyMaterial: keyMaterialForRing() });
  ws = new PhoenixWsClient({ auth, config, logger });
  const rest = new HttpRestClient({ auth, config, logger, fetchImplementation: kdcFetch() });
  const crypto = new SodiumCryptoService({ rest, logger });
  const keyStore = new AuthKeyStore(auth);

  server = createServer({
    config,
    logger,
    deps: { ws, rest, auth, crypto, keyStore, config, logger },
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'clouds-messenger-mcp-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  await client.close();
  await server.close();
  await ws.close();
  await mock.close();
});

describe('каталог инструментов', () => {
  it('выставляет ровно инструменты этой истории, и все они объявлены в каноническом списке', async () => {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();

    expect(names).toEqual([...REGISTERED_TOOLS].sort());
    expect(names).toHaveLength(10);
    for (const name of names) {
      expect(TOOL_NAMES).toContain(name);
    }
  });
});

describe('list_chats', () => {
  it('отдаёт чаты со счётчиком непрочитанного и без ключевого материала', async () => {
    const payload = await callTool<ListChatsResult>('list_chats', {});

    expect(payload.status).toBe('ok');
    expect(payload.total_chats).toBe(3);
    expect(payload.unread_chats).toBe(1);
    expect(payload.chats.map((chat) => chat.chat_id)).toEqual([
      POLYGON_CHAT_ID,
      OTHER_CHAT_ID,
      THIRD_CHAT_ID,
    ]);

    const duty = payload.chats.find((chat) => chat.chat_id === OTHER_CHAT_ID);
    expect(duty?.unread_count).toBe(4);
    expect(duty?.unread).toBe(true);
    expect(payload.chats[0]?.unread).toBe(false);
    expect(JSON.stringify(payload)).not.toContain('recipient-key-id');
  });

  it('по умолчанию не тащит текстов, а по опт-ину отдаёт последнее сообщение', async () => {
    const silent = await callTool<ListChatsResult>('list_chats', {});
    expect(silent.chats.every((chat) => chat.last_message === undefined)).toBe(true);

    const verbose = await callTool<ListChatsResult>('list_chats', { include_last_message_text: true });
    const polygon = verbose.chats.find((chat) => chat.chat_id === POLYGON_CHAT_ID);

    expect(polygon?.last_message?.text).toBe('пятое сообщение');
    expect(polygon?.last_message?.message_id).toBe(syncId(5));
  });

  it('спрашивает полный базовый список и счётчики ровно теми кадрами, что сняты живьём', async () => {
    await callTool<ListChatsResult>('list_chats', {});

    const listFrame = mock.framesOf(CHAT_LIST_EVENT)[0];
    expect(listFrame?.topic).toBe(SYSTEM_TOPIC);
    expect(listFrame?.payload).toEqual({
      since: CHAT_LIST_SINCE_EPOCH,
      request_version: createTestConfig().protocol.chatListRequestVersion,
    });

    const countersFrame = mock.framesOf(UNREAD_COUNTERS_EVENT)[0];
    expect(countersFrame?.topic).toBe(SYSTEM_TOPIC);
    expect(countersFrame?.payload).toEqual({
      group_chats: [POLYGON_CHAT_ID, OTHER_CHAT_ID, THIRD_CHAT_ID],
    });
  });

  it('фильтр по непрочитанному режет выдачу, но не счётчики', async () => {
    const payload = await callTool<ListChatsResult>('list_chats', { unread_only: true });

    expect(payload.chats.map((chat) => chat.chat_id)).toEqual([OTHER_CHAT_ID]);
    expect(payload.total_chats).toBe(3);
  });
});

describe('get_history', () => {
  it('расшифровывает текст и вложение, сортирует от старых к новым и даёт курсор', async () => {
    const payload = await callTool<GetHistoryResult>('get_history', { chat: 'Избранное', limit: 5 });
    if (payload.status !== 'ok') {
      throw new Error('ожидалась успешная выдача');
    }

    expect(payload.chat_id).toBe(POLYGON_CHAT_ID);
    expect(payload.messages.map((message) => message.message_id)).toEqual([
      syncId(1),
      syncId(2),
      syncId(3),
      syncId(4),
      syncId(5),
    ]);
    expect(payload.messages[0]?.text).toBe('первое сообщение');
    expect(payload.messages[0]?.is_self_chat).toBe(true);

    const picture = payload.messages[2];
    expect(picture?.type).toBe('image');
    expect(picture?.attachments?.[0]?.file_name).toBe('снимок.png');
    expect(picture?.attachments?.[0]?.has_preview).toBe(true);
    expect(picture?.read_by_count).toBe(2);

    expect(payload.messages[3]?.reactions).toEqual([{ emoji: '✅', count: 1, mine: true }]);
    expect(payload.next_before).toBe(syncId(1));
  });

  it('признак продолжения не выдумывается: сервер молчит, ключа в выдаче нет', async () => {
    const payload = await callTool<GetHistoryResult>('get_history', { chat: 'Избранное', limit: 2 });
    if (payload.status !== 'ok') {
      throw new Error('ожидалась успешная выдача');
    }

    expect(Object.keys(payload)).not.toContain('has_more');
    expect(Object.keys(payload)).not.toContain('form_status');
  });

  it('курсор исключающий: событие курсора в следующую страницу не попадает', async () => {
    const payload = await callTool<GetHistoryResult>('get_history', {
      chat: POLYGON_CHAT_ID,
      limit: 3,
      before: syncId(3),
    });
    if (payload.status !== 'ok') {
      throw new Error('ожидалась успешная выдача');
    }

    expect(payload.messages.map((message) => message.message_id)).toEqual([syncId(1), syncId(2)]);
  });
});

describe('get_message', () => {
  it('читает сообщение адресным событием и меток неподтверждённости не ставит', async () => {
    const payload = await callTool<GetMessageResult>('get_message', {
      chat: 'Избранное',
      message_id: syncId(4),
    });
    if (payload.status !== 'ok') {
      throw new Error('ожидалась успешная выдача');
    }

    expect(payload.message.message_id).toBe(syncId(4));
    expect(payload.message.text).toBe('четвёртое сообщение');
    expect(Object.keys(payload)).not.toContain('form_status');
  });

  it('отказ сервера на адресном событии уводит на запасной путь, а не роняет вызов', async () => {
    eventInfoRejects = true;

    const payload = await callTool<GetMessageResult>('get_message', {
      chat: 'Избранное',
      message_id: syncId(4),
    });
    if (payload.status !== 'ok') {
      throw new Error('ожидалась успешная выдача');
    }

    expect(payload.message.message_id).toBe(syncId(4));
    expect(payload.message.text).toBe('четвёртое сообщение');
  });

  it('несуществующее сообщение это предметный отказ с инструкцией, а не ошибка MCP', async () => {
    const payload = await callTool<GetMessageResult>('get_message', {
      chat: 'Избранное',
      message_id: syncId(99),
    });

    expect(payload.status).toBe('message_not_found');
    expect(payload.status === 'message_not_found' && payload.next_step).toContain('get_history');
  });
});

describe('get_message_context', () => {
  it('строит окно вокруг метки обеими сторонами и без меток неподтверждённости', async () => {
    const payload = await callTool<GetMessageContextResult>('get_message_context', {
      chat: 'Избранное',
      message_id: syncId(3),
      before_count: 2,
      after_count: 2,
    });
    if (payload.status !== 'ok') {
      throw new Error('ожидалась успешная выдача');
    }

    expect(payload.pivot_message_id).toBe(syncId(3));
    expect(payload.message?.message_id).toBe(syncId(3));
    expect(payload.before.map((message) => message.message_id)).toEqual([syncId(2)]);
    expect(payload.after.map((message) => message.message_id)).toEqual([syncId(4)]);
    expect(Object.keys(payload)).not.toContain('form_status');
  });

  it('метка, найденная проходом по истории, окна не ломает', async () => {
    eventInfoRejects = true;

    const payload = await callTool<GetMessageContextResult>('get_message_context', {
      chat: 'Избранное',
      message_id: syncId(3),
      before_count: 2,
      after_count: 2,
    });
    if (payload.status !== 'ok') {
      throw new Error('ожидалась успешная выдача');
    }

    expect(payload.message?.message_id).toBe(syncId(3));
    expect(payload.after.map((message) => message.message_id)).toEqual([syncId(4)]);
    expect(Object.keys(payload)).not.toContain('form_status');
  });
});

describe('отказы адресации и ошибки слоя', () => {
  it('неоднозначный запрос отдаёт кандидатов и не ходит в историю', async () => {
    const payload = await callTool<GetHistoryResult>('get_history', { chat: 'дежур' });

    expect(payload.status).toBe('ambiguous_chat');
    expect(payload.status === 'ambiguous_chat' && payload.candidates.map((chat) => chat.chat_id)).toEqual([
      OTHER_CHAT_ID,
      THIRD_CHAT_ID,
    ]);
    expect(mock.framesOf(EVENTS_HISTORY_EVENT)).toHaveLength(0);
  });

  it('незнакомый чат отдаёт причину и следующий шаг', async () => {
    const payload = await callTool<GetHistoryResult>('get_history', { chat: 'бухгалтерия' });

    expect(payload.status).toBe('chat_not_found');
    expect(payload.status === 'chat_not_found' && payload.next_step).toContain('list_chats');
  });

  it('прикладной отказ сервера доезжает до MCP с тегом слоя и именем кода', async () => {
    historyRejects = true;

    const text = await callToolExpectingError('get_history', { chat: 'Избранное' });

    expect(text).toContain('get_history:');
    expect(text).toContain('[phoenix] invalid_keys:');
  });
});
