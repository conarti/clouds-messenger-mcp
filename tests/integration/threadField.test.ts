/**
 * Поле `thread` у стартовых сообщений тредов от кадра до выдачи MCP.
 *
 * ГЛАВНОЕ УТВЕРЖДЕНИЕ ПРОВЕРКИ: признак начала треда берётся из внешнего `meta`, число
 * ответов досчитывается одним списком тредов на выдачу и справками для тредов вне списка,
 * сбой этих запросов выдачу не ломает, а страница без тредов не стоит ни одного лишнего
 * запроса. Событие вступления в тред не отправляется ни в одном сценарии.
 */
import sodium from 'libsodium-wrappers-sumo';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { GetHistoryResult } from '../../src/mcp/tools/getHistory.js';
import type { GetMessageResult } from '../../src/mcp/tools/getMessage.js';
import type { GetMessageContextResult } from '../../src/mcp/tools/getMessageContext.js';
import type { GetThreadResult } from '../../src/mcp/tools/getThread.js';
import { EVENT_INFO_EVENT } from '../../src/protocol/eventInfo.js';
import { EVENTS_HISTORY_EVENT } from '../../src/protocol/history.js';
import { THREAD_INFO_EVENT, THREAD_LIST_EVENT } from '../../src/protocol/threads.js';
import { makeKeyRing, type KeyRing } from '../helpers/cryptoFixtures.js';
import {
  MY_HUID,
  POLYGON_CHAT_ID,
  makeHistoryEvent,
  makeInnerText,
  makeRawChat,
  syncId,
} from '../helpers/readFixtures.js';
import { startToolServer, type ToolServer } from '../helpers/toolServer.js';

const PLAIN_ID = syncId(1);
/** Тред, где пользователь участник: есть в списке подписок */
const LISTED_ID = syncId(2);
/** Чужой тред без ответов: только в справке, `counter` равен нулю */
const FOREIGN_ID = syncId(3);
/** Чужой тред, справка о котором отвечает сбоем */
const BROKEN_ID = syncId(4);
/** Стартовое сообщение внутри страницы треда */
const NESTED_ID = syncId(6);
const THREAD_JOIN_EVENT = 'thread_join';

const CHATS = [makeRawChat({ chatId: POLYGON_CHAT_ID, name: 'Избранное', chatType: 'notes' })];

function eventTime(index: number): string {
  return `2026-09-08T07:0${index}:00.000Z`;
}

function rawThread(threadId: string, counter: number): Record<string, unknown> {
  return {
    thread_id: threadId,
    group_chat_id: POLYGON_CHAT_ID,
    counter,
    keys: ['recipient-key-id-a'],
    inserted_at: '2026-09-01T07:00:00.000000Z',
    updated_at: '2026-09-08T07:05:00.000000Z',
  };
}

let ring: KeyRing;
let server: ToolServer;
let chatEvents: Record<string, unknown>[];
let threadEvents: Record<string, unknown>[];
let threadListRejects: boolean;

async function makeEvent(
  index: number,
  groupChatId: string,
  threadStarted: boolean,
): Promise<Record<string, unknown>> {
  return makeHistoryEvent({
    syncId: syncId(index),
    groupChatId,
    insertedAt: eventTime(index),
    sender: MY_HUID,
    senderKeyId: ring.sender.keyId,
    senderPrivateKey: ring.sender.privateKey,
    recipient: ring.recipients[0],
    threadStarted,
    inner: makeInnerText({
      msgId: syncId(index),
      from: MY_HUID,
      timestamp: eventTime(index),
      groupChatId,
      body: `сообщение номер ${index}`,
    }),
  });
}

function historyPage(payload: Record<string, unknown>): unknown {
  const requested = payload['group_chat_id'];
  let source: Record<string, unknown>[] = [];
  if (requested === POLYGON_CHAT_ID) {
    source = chatEvents;
  } else if (requested === LISTED_ID) {
    source = threadEvents;
  }
  const cursor = payload['sync_id'];
  const limit = payload['limit'] as number;
  const direction = payload['direction'];
  let pool = [...source];
  if (typeof cursor === 'string') {
    const at = pool.findIndex((event) => event['sync_id'] === cursor);
    if (at >= 0) {
      pool = direction === 'forward' ? pool.slice(at) : pool.slice(0, at + 1);
    }
  }
  const slice = direction === 'forward' ? pool.slice(0, limit) : pool.slice(-limit);
  return { history: [...slice].reverse(), has_more: false };
}

beforeAll(async () => {
  await sodium.ready;
  ring = await makeKeyRing();
});

beforeEach(async () => {
  threadListRejects = false;
  chatEvents = [
    await makeEvent(1, POLYGON_CHAT_ID, false),
    await makeEvent(2, POLYGON_CHAT_ID, true),
    await makeEvent(3, POLYGON_CHAT_ID, true),
    await makeEvent(4, POLYGON_CHAT_ID, true),
    await makeEvent(5, POLYGON_CHAT_ID, false),
  ];
  threadEvents = [await makeEvent(6, LISTED_ID, true)];
  server = await startToolServer({ ring, chats: CHATS });

  const listed = [rawThread(LISTED_ID, 3)];
  const known: Record<string, unknown>[] = [
    { ...rawThread(LISTED_ID, 3), active: true },
    { ...rawThread(FOREIGN_ID, 0), active: false },
    { ...rawThread(NESTED_ID, 1), active: false },
  ];
  server.mock.respondTo(THREAD_LIST_EVENT, () =>
    threadListRejects
      ? { status: 'error', response: { error: 'internal_error' } }
      : { status: 'ok', response: { [THREAD_LIST_EVENT]: listed } },
  );
  server.mock.respondTo(THREAD_INFO_EVENT, (frame) => {
    const payload = frame.payload as Record<string, unknown>;
    if (payload['thread_id'] === BROKEN_ID) {
      return { status: 'error', response: { error: 'internal_error' } };
    }
    const info = known.find((thread) => thread['thread_id'] === payload['thread_id']);
    return info === undefined
      ? { status: 'error', response: { error: 'thread_not_found' } }
      : { status: 'ok', response: { [THREAD_INFO_EVENT]: info } };
  });
  server.mock.respondTo(EVENT_INFO_EVENT, (frame) => {
    const requested = (frame.payload as Record<string, unknown>)['sync_ids'] as string[];
    return {
      status: 'ok',
      response: {
        [EVENT_INFO_EVENT]: chatEvents.filter((event) => requested.includes(event['sync_id'] as string)),
      },
    };
  });
  server.mock.respondTo(EVENTS_HISTORY_EVENT, (frame) => ({
    status: 'ok',
    response: historyPage(frame.payload as Record<string, unknown>),
  }));
});

afterEach(async () => {
  expect(server.mock.framesOf(THREAD_JOIN_EVENT)).toHaveLength(0);
  await server.close();
});

function expectOk<T extends { status: string }>(payload: T): Extract<T, { status: 'ok' }> {
  if (payload.status !== 'ok') {
    throw new Error('ожидалась успешная выдача');
  }
  return payload as Extract<T, { status: 'ok' }>;
}

async function readHistory(): Promise<Extract<GetHistoryResult, { status: 'ok' }>> {
  return expectOk(await server.callTool<GetHistoryResult>('get_history', { chat: 'Избранное' }));
}

function byId<T extends { message_id: string }>(messages: readonly T[], id: string): T | undefined {
  return messages.find((message) => message.message_id === id);
}

describe('get_history: поле thread', () => {
  it('признак в meta даёт thread, счётчик берётся из списка и из справки', async () => {
    const payload = await readHistory();

    expect(byId(payload.messages, LISTED_ID)?.thread).toEqual({ thread_id: LISTED_ID, replies_count: 3 });
    expect(byId(payload.messages, FOREIGN_ID)?.thread).toEqual({ thread_id: FOREIGN_ID, replies_count: 0 });
    expect(server.mock.framesOf(THREAD_LIST_EVENT)).toHaveLength(1);
    const asked = server.mock
      .framesOf(THREAD_INFO_EVENT)
      .map((frame) => (frame.payload as Record<string, unknown>)['thread_id']);
    expect(asked.sort()).toEqual([FOREIGN_ID, BROKEN_ID].sort());
  });

  it('сообщение без признака не несёт поля thread', async () => {
    const payload = await readHistory();

    expect(Object.keys(byId(payload.messages, PLAIN_ID) ?? {})).not.toContain('thread');
    expect(Object.keys(byId(payload.messages, syncId(5)) ?? {})).not.toContain('thread');
  });

  it('сбой справки оставляет thread без replies_count и не ломает выдачу', async () => {
    const payload = await readHistory();

    expect(payload.messages).toHaveLength(5);
    expect(byId(payload.messages, BROKEN_ID)?.thread).toEqual({ thread_id: BROKEN_ID });
  });

  it('сбой списка тредов не прячет счётчики: они берутся справками', async () => {
    threadListRejects = true;

    const payload = await readHistory();

    expect(payload.messages).toHaveLength(5);
    expect(byId(payload.messages, LISTED_ID)?.thread).toEqual({ thread_id: LISTED_ID, replies_count: 3 });
    expect(byId(payload.messages, BROKEN_ID)?.thread).toEqual({ thread_id: BROKEN_ID });
  });

  it('страница без тредов не стоит ни списка тредов, ни справок', async () => {
    chatEvents = [await makeEvent(1, POLYGON_CHAT_ID, false), await makeEvent(5, POLYGON_CHAT_ID, false)];

    const payload = await readHistory();

    expect(payload.messages).toHaveLength(2);
    expect(server.mock.framesOf(THREAD_LIST_EVENT)).toHaveLength(0);
    expect(server.mock.framesOf(THREAD_INFO_EVENT)).toHaveLength(0);
  });
});

describe('поле thread в остальных инструментах чтения', () => {
  it('get_message отдаёт thread со счётчиком', async () => {
    const payload = expectOk(
      await server.callTool<GetMessageResult>('get_message', {
        chat: 'Избранное',
        message_id: LISTED_ID,
      }),
    );

    expect(payload.message.thread).toEqual({ thread_id: LISTED_ID, replies_count: 3 });
  });

  it('get_message_context считает счётчики всего окна одним списком тредов', async () => {
    const payload = expectOk(
      await server.callTool<GetMessageContextResult>('get_message_context', {
        chat: 'Избранное',
        message_id: FOREIGN_ID,
        before_count: 2,
        after_count: 2,
      }),
    );

    expect(payload.message?.thread).toEqual({ thread_id: FOREIGN_ID, replies_count: 0 });
    expect(byId(payload.before, LISTED_ID)?.thread).toEqual({ thread_id: LISTED_ID, replies_count: 3 });
    expect(Object.keys(byId(payload.before, PLAIN_ID) ?? {})).not.toContain('thread');
    expect(byId(payload.after, BROKEN_ID)?.thread).toEqual({ thread_id: BROKEN_ID });
    expect(server.mock.framesOf(THREAD_LIST_EVENT)).toHaveLength(1);
  });

  it('get_thread отдаёт thread у стартового сообщения на странице треда', async () => {
    const payload = expectOk(
      await server.callTool<GetThreadResult>('get_thread', {
        chat: 'Избранное',
        thread_id: LISTED_ID,
      }),
    );

    expect(payload.messages.map((message) => message.thread)).toEqual([
      { thread_id: NESTED_ID, replies_count: 1 },
    ]);
  });
});
