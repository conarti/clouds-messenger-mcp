/**
 * `get_thread` от кадра до выдачи MCP.
 *
 * Тред здесь настоящий чат: его события зашифрованы тем же способом и лежат в топике
 * собственного адреса треда, поэтому доказывается не только форма ответа, но и то, что
 * история треда читается тем же путём, что и история чата, без отдельной механики.
 *
 * ГЛАВНОЕ УТВЕРЖДЕНИЕ ПРОВЕРКИ: тред вне списка подписок читается через справку
 * `thread_info` с `source:'direct'`, тред другого чата и неизвестный адрес дают
 * `thread_not_found`, а `thread_join` не отправляется ни в одном сценарии.
 */
import sodium from 'libsodium-wrappers-sumo';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { GetThreadResult } from '../../src/mcp/tools/getThread.js';
import { EVENTS_HISTORY_EVENT } from '../../src/protocol/history.js';
import { THREAD_INFO_EVENT, THREAD_LIST_EVENT } from '../../src/protocol/threads.js';
import { makeKeyRing, type KeyRing } from '../helpers/cryptoFixtures.js';
import {
  MY_HUID,
  OTHER_CHAT_ID,
  POLYGON_CHAT_ID,
  makeHistoryEvent,
  makeInnerText,
  makeRawChat,
  syncId,
} from '../helpers/readFixtures.js';
import { startToolServer, type ToolServer } from '../helpers/toolServer.js';

/** Адрес треда равен адресу стартового сообщения */
const THREAD_ID = '11111111-1111-4111-8111-111111111111';
const EMPTY_THREAD_ID = '22222222-2222-4222-8222-222222222222';
const UNKNOWN_THREAD_ID = '33333333-3333-4333-8333-333333333333';
/** Тред полигона, где пользователь не участник: в списке подписок его нет */
const FOREIGN_THREAD_ID = '44444444-4444-4444-8444-444444444444';
/** Тред другого чата, тоже вне списка подписок */
const OTHER_CHAT_THREAD_ID = '55555555-5555-4555-8555-555555555555';
/** Событие, которое делает пользователя участником треда: отправлять его нельзя */
const THREAD_JOIN_EVENT = 'thread_join';

const CHATS = [
  makeRawChat({ chatId: POLYGON_CHAT_ID, name: 'Избранное', chatType: 'notes' }),
  makeRawChat({ chatId: OTHER_CHAT_ID, name: 'Дежурка', chatType: 'group_chat' }),
];

function rawThread(threadId: string, chatId: string): Record<string, unknown> {
  return {
    thread_id: threadId,
    group_chat_id: chatId,
    counter: 0,
    keys: ['recipient-key-id-a'],
    inserted_at: '2026-09-01T07:00:00.000000Z',
    updated_at: '2026-09-08T07:05:00.000000Z',
    last_event_sync_id: syncId(2),
    last_event_inserted_at: '2026-09-08T07:02:00.000000Z',
  };
}

let ring: KeyRing;
let server: ToolServer;
let threadEvents: Record<string, unknown>[];
let foreignThreadEvents: Record<string, unknown>[];

async function buildThreadEvents(threadId: string): Promise<Record<string, unknown>[]> {
  const common = {
    /* Топик и адрес события это САМ ТРЕД: тред и есть чат для своих сообщений */
    groupChatId: threadId,
    sender: MY_HUID,
    senderKeyId: ring.sender.keyId,
    senderPrivateKey: ring.sender.privateKey,
    recipient: ring.recipients[0],
  };
  return [
    await makeHistoryEvent({
      ...common,
      syncId: syncId(1),
      insertedAt: '2026-09-08T07:01:00.000Z',
      inner: makeInnerText({
        msgId: syncId(1),
        from: MY_HUID,
        timestamp: '2026-09-08T07:01:00.000Z',
        groupChatId: threadId,
        body: 'первый ответ в треде',
      }),
    }),
    await makeHistoryEvent({
      ...common,
      syncId: syncId(2),
      insertedAt: '2026-09-08T07:02:00.000Z',
      inner: makeInnerText({
        msgId: syncId(2),
        from: MY_HUID,
        timestamp: '2026-09-08T07:02:00.000Z',
        groupChatId: threadId,
        body: 'второй ответ в треде',
        reply: {
          syncId: syncId(1),
          from: MY_HUID,
          body: 'первый ответ в треде',
          sourceName: 'Синтетический Автор',
          groupChatId: threadId,
        },
      }),
    }),
  ];
}

beforeAll(async () => {
  await sodium.ready;
  ring = await makeKeyRing();
});

beforeEach(async () => {
  threadEvents = await buildThreadEvents(THREAD_ID);
  foreignThreadEvents = await buildThreadEvents(FOREIGN_THREAD_ID);
  server = await startToolServer({ ring, chats: CHATS });

  const listed = [rawThread(THREAD_ID, POLYGON_CHAT_ID), rawThread(EMPTY_THREAD_ID, POLYGON_CHAT_ID)];
  const known: Record<string, unknown>[] = [
    ...listed.map((thread) => ({ ...thread, active: true })),
    { ...rawThread(FOREIGN_THREAD_ID, POLYGON_CHAT_ID), active: false },
    { ...rawThread(OTHER_CHAT_THREAD_ID, OTHER_CHAT_ID), active: false },
  ];
  /* Сервер игнорирует сужение по чату и всегда отдаёт полный список подписок */
  server.mock.respondTo(THREAD_LIST_EVENT, () => ({
    status: 'ok',
    response: { [THREAD_LIST_EVENT]: listed },
  }));
  server.mock.respondTo(THREAD_INFO_EVENT, (frame) => {
    const payload = frame.payload as Record<string, unknown>;
    const info = known.find((thread) => thread['thread_id'] === payload['thread_id']);
    return info === undefined
      ? { status: 'error', response: { error: 'thread_not_found' } }
      : { status: 'ok', response: { [THREAD_INFO_EVENT]: info } };
  });
  server.mock.respondTo(EVENTS_HISTORY_EVENT, (frame) => {
    const payload = frame.payload as Record<string, unknown>;
    const requested = payload['group_chat_id'];
    const events =
      requested === THREAD_ID
        ? threadEvents
        : requested === FOREIGN_THREAD_ID
          ? foreignThreadEvents
          : [];
    /*
     * Признак продолжения сервер здесь ПРИСЫЛАЕТ: так проверяется, что при живом ответе
     * сервера выдача не обрастает меткой неподтверждённости.
     */
    return { status: 'ok', response: { history: [...events].reverse(), has_more: false } };
  });
});

afterEach(async () => {
  /* Чтение треда никогда не меняет участие пользователя */
  expect(server.mock.framesOf(THREAD_JOIN_EVENT)).toHaveLength(0);
  await server.close();
});

describe('get_thread по готовому адресу треда', () => {
  it('читает тело треда и НЕ помечает выдачу неподтверждённой', async () => {
    const payload = await server.callTool<GetThreadResult>('get_thread', {
      chat: 'Избранное',
      thread_id: THREAD_ID,
    });
    if (payload.status !== 'ok') {
      throw new Error('ожидалась успешная выдача');
    }

    expect(payload.thread_id).toBe(THREAD_ID);
    expect(payload.chat_id).toBe(POLYGON_CHAT_ID);
    expect(payload.source).toBe('thread_list');
    expect(payload.participant).toBe(true);
    expect(server.mock.framesOf(THREAD_INFO_EVENT)).toHaveLength(0);
    expect(payload.empty).toBe(false);
    expect(payload.messages.map((message) => message.message_id)).toEqual([syncId(1), syncId(2)]);
    expect(payload.messages[0]?.text).toBe('первый ответ в треде');
    /* Сообщение треда адресуется самим тредом, а имя чата в нём это имя РОДИТЕЛЬСКОГО чата */
    expect(payload.messages[0]?.chat_id).toBe(THREAD_ID);
    expect(payload.messages[0]?.chat_name).toBe('Избранное');
    expect(Object.keys(payload.messages[0] ?? {})).not.toContain('reply_to');
    expect(payload.messages[1]?.reply_to).toEqual({
      message_id: syncId(1),
      from: MY_HUID,
      from_name: 'Синтетический Автор',
      text_preview: 'первый ответ в треде',
    });
    expect(payload.has_more).toBe(false);
    expect(Object.keys(payload)).not.toContain('form_status');
    expect(payload.next_before).toBe(syncId(1));
  });

  it('сервер без признака продолжения истории треда даёт form_status:unconfirmed', async () => {
    /* Тот же ответчик, но без has_more и has_more_events: страница треда живьём не подтверждена */
    server.mock.respondTo(EVENTS_HISTORY_EVENT, (frame) => {
      const payload = frame.payload as Record<string, unknown>;
      const events = payload['group_chat_id'] === THREAD_ID ? threadEvents : [];
      return { status: 'ok', response: { history: [...events].reverse() } };
    });

    const payload = await server.callTool<GetThreadResult>('get_thread', {
      chat: 'Избранное',
      thread_id: THREAD_ID,
    });
    if (payload.status !== 'ok') {
      throw new Error('ожидалась успешная выдача');
    }

    expect(payload.thread_id).toBe(THREAD_ID);
    expect(payload.messages.map((message) => message.message_id)).toEqual([syncId(1), syncId(2)]);
    expect(payload.form_status).toBe('unconfirmed');
    expect(payload.form_note).toContain('признак продолжения');
    expect(Object.keys(payload)).not.toContain('has_more');
  });

  it('тред без событий это пустая выдача, а не отказ доступа', async () => {
    const payload = await server.callTool<GetThreadResult>('get_thread', {
      chat: 'Избранное',
      thread_id: EMPTY_THREAD_ID,
    });
    if (payload.status !== 'ok') {
      throw new Error('ожидалась успешная выдача');
    }

    expect(payload.empty).toBe(true);
    expect(payload.messages).toEqual([]);
    expect(Object.keys(payload)).not.toContain('next_before');
  });

  it('незнакомый тред это предметный отказ с причиной, а не ошибка MCP', async () => {
    const payload = await server.callTool<GetThreadResult>('get_thread', {
      chat: 'Избранное',
      thread_id: UNKNOWN_THREAD_ID,
    });

    expect(payload.status).toBe('thread_not_found');
    expect(payload.status === 'thread_not_found' && payload.reason).toContain(UNKNOWN_THREAD_ID);
    expect(payload.status === 'thread_not_found' && payload.next_step).toContain('message_id');
    expect(server.mock.framesOf(EVENTS_HISTORY_EVENT)).toHaveLength(0);
  });
});

describe('get_thread для треда вне списка подписок', () => {
  it('читает чужой тред через справку thread_info, не делая пользователя участником', async () => {
    const payload = await server.callTool<GetThreadResult>('get_thread', {
      chat: 'Избранное',
      thread_id: FOREIGN_THREAD_ID,
    });
    if (payload.status !== 'ok') {
      throw new Error('ожидалась успешная выдача');
    }

    expect(payload.thread_id).toBe(FOREIGN_THREAD_ID);
    expect(payload.chat_id).toBe(POLYGON_CHAT_ID);
    expect(payload.source).toBe('direct');
    expect(payload.participant).toBe(false);
    expect(payload.messages.map((message) => message.text)).toEqual([
      'первый ответ в треде',
      'второй ответ в треде',
    ]);
    expect(server.mock.framesOf(THREAD_INFO_EVENT)[0]?.payload).toEqual({
      thread_id: FOREIGN_THREAD_ID,
    });
    expect(server.mock.framesOf(THREAD_JOIN_EVENT)).toHaveLength(0);
  });

  it('тред, начатый в другом чате, это thread_not_found', async () => {
    const payload = await server.callTool<GetThreadResult>('get_thread', {
      chat: 'Избранное',
      thread_id: OTHER_CHAT_THREAD_ID,
    });

    expect(payload.status).toBe('thread_not_found');
    expect(payload.status === 'thread_not_found' && payload.reason).toContain('в другом');
    expect(server.mock.framesOf(EVENTS_HISTORY_EVENT)).toHaveLength(0);
  });
});

describe('get_thread по адресу стартового сообщения', () => {
  it('адрес треда равен message_id, и выдача по нему ничем не помечается', async () => {
    const payload = await server.callTool<GetThreadResult>('get_thread', {
      chat: 'Избранное',
      message_id: THREAD_ID,
    });
    if (payload.status !== 'ok') {
      throw new Error('ожидалась успешная выдача');
    }

    expect(payload.thread_id).toBe(THREAD_ID);
    expect(payload.source).toBe('thread_list');
    expect(Object.keys(payload)).not.toContain('form_status');
    expect(payload.messages).toHaveLength(2);
  });

  it('сообщение без треда даёт thread_not_found, а не историю чужого адреса', async () => {
    const payload = await server.callTool<GetThreadResult>('get_thread', {
      chat: 'Избранное',
      message_id: UNKNOWN_THREAD_ID,
    });

    expect(payload.status).toBe('thread_not_found');
    expect(server.mock.framesOf(EVENTS_HISTORY_EVENT)).toHaveLength(0);
  });

  it('вызов без обоих идентификаторов не идёт к серверу вовсе', async () => {
    const payload = await server.callTool<GetThreadResult>('get_thread', { chat: 'Избранное' });

    expect(payload.status).toBe('invalid_input');
    expect(server.mock.framesOf(THREAD_LIST_EVENT)).toHaveLength(0);
  });
});
