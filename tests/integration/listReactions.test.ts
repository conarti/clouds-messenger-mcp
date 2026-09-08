/**
 * `list_reactions` от кадра до выдачи MCP.
 *
 * Реакции живут во ВНЕШНЕМ событии, поэтому проверка идёт через настоящий путь чтения
 * события целиком: сначала адресный, затем запасной по истории. Оба пути наблюдены живьём
 * на полигоне, поэтому меток неподтверждённости в выдаче нет ни на одном из них.
 *
 * ГЛАВНОЕ УТВЕРЖДЕНИЕ: путь чтения на форму реакций не влияет. Каким бы путём событие ни
 * нашлось, список реакций не меняется ни на байт.
 */
import sodium from 'libsodium-wrappers-sumo';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ListReactionsResult } from '../../src/mcp/tools/listReactions.js';
import { EVENT_INFO_EVENT } from '../../src/protocol/eventInfo.js';
import { EVENTS_HISTORY_EVENT } from '../../src/protocol/history.js';
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

const CHATS = [makeRawChat({ chatId: POLYGON_CHAT_ID, name: 'Избранное', chatType: 'notes' })];

let ring: KeyRing;
let server: ToolServer;
let historyEvents: Record<string, unknown>[];
/** Отказ сервера на адресном событии: так проверяется запасной путь по истории */
let eventInfoRejects: boolean;

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
      insertedAt: '2026-09-08T07:01:00.000Z',
      inner: makeInnerText({
        msgId: syncId(1),
        from: MY_HUID,
        timestamp: '2026-09-08T07:01:00.000Z',
        groupChatId: POLYGON_CHAT_ID,
        body: 'сообщение без реакций',
      }),
    }),
    await makeHistoryEvent({
      ...common,
      syncId: syncId(2),
      insertedAt: '2026-09-08T07:02:00.000Z',
      /* Живой образец строки счётчиков плюс вторая реакция, чтобы разбор не выглядел удачей */
      reactionCounters: '✅:1, 👍:3',
      myReactions: ['✅'],
      inner: makeInnerText({
        msgId: syncId(2),
        from: MY_HUID,
        timestamp: '2026-09-08T07:02:00.000Z',
        groupChatId: POLYGON_CHAT_ID,
        body: 'сообщение с реакциями',
      }),
    }),
  ];
}

beforeAll(async () => {
  await sodium.ready;
  ring = await makeKeyRing();
});

beforeEach(async () => {
  eventInfoRejects = false;
  historyEvents = await buildHistory();
  server = await startToolServer({ ring, chats: CHATS });

  server.mock.respondTo(EVENT_INFO_EVENT, (frame) => {
    if (eventInfoRejects) {
      return { status: 'error', response: { error: 'unknown_event' } };
    }
    const requested = (frame.payload as Record<string, unknown>)['sync_ids'] as string[];
    return {
      status: 'ok',
      response: {
        [EVENT_INFO_EVENT]: historyEvents.filter((event) =>
          requested.includes(event['sync_id'] as string),
        ),
      },
    };
  });
  server.mock.respondTo(EVENTS_HISTORY_EVENT, (frame) => {
    const payload = frame.payload as Record<string, unknown>;
    const cursor = payload['sync_id'];
    let pool = [...historyEvents];
    if (typeof cursor === 'string') {
      const at = pool.findIndex((event) => event['sync_id'] === cursor);
      /* Событие курсора ВКЛЮЧЕНО: включающая семантика живьём не установлена */
      pool = at >= 0 ? pool.slice(0, at + 1) : [];
    }
    return { status: 'ok', response: { history: pool.slice(-(payload['limit'] as number)).reverse() } };
  });
});

afterEach(async () => {
  await server.close();
});

describe('list_reactions', () => {
  it('отдаёт счётчики с пометкой своих и суммой', async () => {
    const payload = await server.callTool<ListReactionsResult>('list_reactions', {
      chat: 'Избранное',
      message_id: syncId(2),
    });
    if (payload.status !== 'ok') {
      throw new Error('ожидалась успешная выдача');
    }

    expect(payload.chat_id).toBe(POLYGON_CHAT_ID);
    expect(payload.message_id).toBe(syncId(2));
    expect(payload.reactions).toEqual([
      { emoji: '✅', count: 1, mine: true },
      { emoji: '👍', count: 3, mine: false },
    ]);
    expect(payload.total).toBe(4);
  });

  it('реакция это эмодзи, а не числовой идентификатор артворка', async () => {
    const payload = await server.callTool<ListReactionsResult>('list_reactions', {
      chat: 'Избранное',
      message_id: syncId(2),
    });
    if (payload.status !== 'ok') {
      throw new Error('ожидалась успешная выдача');
    }

    for (const reaction of payload.reactions) {
      expect(typeof reaction.emoji).toBe('string');
      expect(Number.isNaN(Number(reaction.emoji))).toBe(true);
    }
  });

  it('адресное чтение метки неподтверждённости не ставит: путь наблюдён живьём', async () => {
    const payload = await server.callTool<ListReactionsResult>('list_reactions', {
      chat: 'Избранное',
      message_id: syncId(2),
    });
    if (payload.status !== 'ok') {
      throw new Error('ожидалась успешная выдача');
    }

    expect(Object.keys(payload)).not.toContain('form_status');
    expect(payload.reactions.map((reaction) => reaction.emoji)).toEqual(['✅', '👍']);
  });

  it('на запасном пути чтения выдача та же и тоже без меток', async () => {
    eventInfoRejects = true;

    const payload = await server.callTool<ListReactionsResult>('list_reactions', {
      chat: 'Избранное',
      message_id: syncId(2),
    });
    if (payload.status !== 'ok') {
      throw new Error('ожидалась успешная выдача');
    }

    expect(Object.keys(payload)).not.toContain('form_status');
    expect(Object.keys(payload)).not.toContain('form_note');
    /* Реакции те же самые: путь чтения на форму не влияет */
    expect(payload.reactions.map((reaction) => reaction.emoji)).toEqual(['✅', '👍']);
  });

  it('сообщение без реакций отдаёт пустой список, а не отсутствие поля', async () => {
    const payload = await server.callTool<ListReactionsResult>('list_reactions', {
      chat: 'Избранное',
      message_id: syncId(1),
    });
    if (payload.status !== 'ok') {
      throw new Error('ожидалась успешная выдача');
    }

    expect(payload.reactions).toEqual([]);
    expect(payload.total).toBe(0);
  });

  it('несуществующее сообщение это предметный отказ с инструкцией', async () => {
    const payload = await server.callTool<ListReactionsResult>('list_reactions', {
      chat: 'Избранное',
      message_id: syncId(99),
    });

    expect(payload.status).toBe('message_not_found');
    expect(payload.status === 'message_not_found' && payload.next_step).toContain('get_history');
  });
});
