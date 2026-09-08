/**
 * `get_poll` от кадра до выдачи MCP.
 *
 * ФОРМА ОПРОСА ЗДЕСЬ НЕПОДТВЕРЖДЁННАЯ, и проверка это не скрывает: опрос нельзя завести в
 * чате с собой, живой пробы у него нет (findings.md, P3), поэтому внутреннее событие опроса
 * собрано по бандлу веб-клиента. Ровно поэтому же метка `form_status` проверяется во ВСЕХ
 * исходах, включая отрицательный: «это не опрос» тоже вывод из неподтверждённого признака.
 *
 * Отдельно доказывается, что неприменимость отличается от отсутствия: в заметках и в личном
 * чате опроса не может быть в принципе, и сервер об этом даже не спрашивается.
 */
import sodium from 'libsodium-wrappers-sumo';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { GetPollResult } from '../../src/mcp/tools/getPoll.js';
import { EVENT_INFO_EVENT } from '../../src/protocol/eventInfo.js';
import { EVENTS_HISTORY_EVENT } from '../../src/protocol/history.js';
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

const PRIVATE_CHAT_ID = '7f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const POLL_ID = 'poll-0001';

const CHATS = [
  makeRawChat({ chatId: POLYGON_CHAT_ID, name: 'Избранное', chatType: 'notes' }),
  makeRawChat({ chatId: OTHER_CHAT_ID, name: 'Дежурка', chatType: 'group_chat' }),
  makeRawChat({ chatId: PRIVATE_CHAT_ID, name: 'Личный', chatType: 'chat' }),
];

/** Внутреннее событие опроса по форме из бандла: живьём такое событие не наблюдалось */
function makeInnerPoll(): Record<string, unknown> {
  return {
    type: 'poll',
    msg_id: syncId(2),
    from: MY_HUID,
    timestamp: '2026-09-08T07:02:00.000Z',
    group_chat_id: OTHER_CHAT_ID,
    payload: {
      poll_id: POLL_ID,
      question: 'кто дежурит в выходные',
      variants: [
        { id: 'variant-1', text: 'я' },
        { id: 'variant-2', text: 'не я' },
      ],
      poll_settings: { is_anonymous: false, max_choices: 1 },
      poll_type: 'single',
    },
  };
}

let ring: KeyRing;
let server: ToolServer;
let historyEvents: Record<string, unknown>[];

async function buildHistory(): Promise<Record<string, unknown>[]> {
  const common = {
    groupChatId: OTHER_CHAT_ID,
    sender: MY_HUID,
    senderKeyId: ring.sender.keyId,
    senderPrivateKey: ring.sender.privateKey,
    recipient: ring.recipients[0],
  };
  const text = await makeHistoryEvent({
    ...common,
    syncId: syncId(1),
    insertedAt: '2026-09-08T07:01:00.000Z',
    inner: makeInnerText({
      msgId: syncId(1),
      from: MY_HUID,
      timestamp: '2026-09-08T07:01:00.000Z',
      groupChatId: OTHER_CHAT_ID,
      body: 'обычное сообщение, а не опрос',
    }),
  });
  const poll = await makeHistoryEvent({
    ...common,
    syncId: syncId(2),
    insertedAt: '2026-09-08T07:02:00.000Z',
    inner: makeInnerPoll(),
  });
  /* Свой голос приезжает рядом со своими реакциями: имя поля наблюдено живьём, элемент нет */
  poll['meta'] = { activities: { user_reactions: { emoji: [], votes: ['variant-1'] } } };
  return [text, poll];
}

beforeAll(async () => {
  await sodium.ready;
  ring = await makeKeyRing();
});

beforeEach(async () => {
  historyEvents = await buildHistory();
  server = await startToolServer({ ring, chats: CHATS });

  server.mock.respondTo(EVENT_INFO_EVENT, (frame) => {
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
  server.mock.respondTo(EVENTS_HISTORY_EVENT, () => ({ status: 'ok', response: { history: [] } }));
});

afterEach(async () => {
  await server.close();
});

describe('get_poll в групповом чате', () => {
  it('отдаёт сырые поля опроса, его адрес и свой голос', async () => {
    const payload = await server.callTool<GetPollResult>('get_poll', {
      chat: 'Дежурка',
      message_id: syncId(2),
    });
    if (payload.status !== 'ok') {
      throw new Error('ожидалась успешная выдача');
    }

    expect(payload.chat_id).toBe(OTHER_CHAT_ID);
    expect(payload.poll_id).toBe(POLL_ID);
    expect(payload.poll['question']).toBe('кто дежурит в выходные');
    expect(payload.poll['variants']).toHaveLength(2);
    /* Нормализации нет намеренно: поля уходят наружу теми же именами, что приехали */
    expect(payload.poll['poll_settings']).toEqual({ is_anonymous: false, max_choices: 1 });
    expect(payload.my_votes).toEqual(['variant-1']);
  });

  it('форма объявлена неподтверждённой прямо в выдаче', async () => {
    const payload = await server.callTool<GetPollResult>('get_poll', {
      chat: 'Дежурка',
      message_id: syncId(2),
    });
    if (payload.status !== 'ok') {
      throw new Error('ожидалась успешная выдача');
    }

    expect(payload.form_status).toBe('unconfirmed');
    expect(payload.form_note).toContain('бандл');
  });

  it('обычное сообщение это not_a_poll, и признак опроса тоже объявлен неподтверждённым', async () => {
    const payload = await server.callTool<GetPollResult>('get_poll', {
      chat: 'Дежурка',
      message_id: syncId(1),
    });
    if (payload.status !== 'not_a_poll') {
      throw new Error('ожидался отказ not_a_poll');
    }

    expect(payload.form_status).toBe('unconfirmed');
    expect(payload.reason).toContain(syncId(1));
  });

  it('несуществующее сообщение это message_not_found', async () => {
    const payload = await server.callTool<GetPollResult>('get_poll', {
      chat: 'Дежурка',
      message_id: syncId(99),
    });

    expect(payload.status).toBe('message_not_found');
  });
});

describe('get_poll там, где опроса не бывает', () => {
  it('в заметках вызов не идёт к серверу за событием вовсе', async () => {
    const payload = await server.callTool<GetPollResult>('get_poll', {
      chat: 'Избранное',
      message_id: syncId(2),
    });

    expect(payload.status).toBe('not_applicable');
    expect(payload.status === 'not_applicable' && payload.reason).toContain('групповых');
    expect(server.mock.framesOf(EVENT_INFO_EVENT)).toHaveLength(0);
  });

  it('в личном чате ответ тот же: неприменимо, а не «не опрос»', async () => {
    const payload = await server.callTool<GetPollResult>('get_poll', {
      chat: 'Личный',
      message_id: syncId(2),
    });

    expect(payload.status).toBe('not_applicable');
    expect(payload.status === 'not_applicable' && payload.next_step).toContain('list_chats');
  });
});
