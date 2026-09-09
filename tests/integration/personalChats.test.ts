/**
 * Личные чаты от кадра до выдачи MCP: имя собеседника, поиск человека и адресация по имени.
 *
 * Проверка стоит отдельно от прочих инструментов чтения, потому что доказывает не форму
 * ответа, а СВЯЗКУ двух источников: список чатов приходит с одинаковой серверной заглушкой
 * имени у всех личных чатов, а имена лежат в справке о профилях, и без неё список
 * бесполезен ровно там, где человек его читает глазами.
 *
 * Настоящими здесь являются все слои, кроме двух подмен: адрес сокета ведёт в локальный
 * Phoenix-мок, а REST (KDC и справка) отвечает подложным fetch. Имена в фикстурах
 * синтетические: живому имени коллеги в репозитории места нет.
 */
import sodium from 'libsodium-wrappers-sumo';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { GetHistoryResult } from '../../src/mcp/tools/getHistory.js';
import type { ListChatsResult } from '../../src/mcp/tools/listChats.js';
import type { SearchResult } from '../../src/mcp/tools/search.js';
import { EVENTS_HISTORY_EVENT } from '../../src/protocol/history.js';
import { makeKeyRing, type KeyRing } from '../helpers/cryptoFixtures.js';
import {
  makeHistoryEvent,
  makeInnerLink,
  makeInnerText,
  makeRawChat,
  MY_HUID,
  NAMELESS_PEER_HUID,
  PEER_HUID,
  SECOND_PEER_HUID,
  syncId,
  type ProfileFixture,
} from '../helpers/readFixtures.js';
import { startToolServer, type ToolServer } from '../helpers/toolServer.js';

const PERSONAL_CHAT_ID = '7f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const SECOND_PERSONAL_CHAT_ID = '8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const NAMELESS_CHAT_ID = '9b2c3d4e-5f6a-4b7c-8d8e-0f1a2b3c4d5e';
const GROUP_CHAT_ID = 'ac3d4e5f-6a7b-4c8d-89ef-1a2b3c4d5e6f';
const MENTION_ID = 'bd4e5f6a-7b8c-4d9e-8f01-2a3b4c5d6e7f';

const PROFILES: ProfileFixture[] = [
  {
    huid: PEER_HUID,
    name: 'Тестов Тест Тестович',
    companyPosition: 'Главный инженер',
    department: 'Отдел проб',
  },
  { huid: SECOND_PEER_HUID, name: 'Пробова Проба Пробовна', department: 'Отдел проб' },
];

/** Все личные чаты приезжают с сервера под одним и тем же именем: это и есть предпосылка */
const CHATS = [
  makeRawChat({
    chatId: PERSONAL_CHAT_ID,
    name: 'personal chat',
    chatType: 'chat',
    memberHuids: [MY_HUID, PEER_HUID],
    updatedAt: '2026-09-08T07:05:00.000000Z',
  }),
  makeRawChat({
    chatId: SECOND_PERSONAL_CHAT_ID,
    name: 'personal chat',
    chatType: 'chat',
    memberHuids: [MY_HUID, SECOND_PEER_HUID],
    updatedAt: '2026-09-08T07:04:00.000000Z',
  }),
  makeRawChat({
    chatId: NAMELESS_CHAT_ID,
    name: 'personal chat',
    chatType: 'chat',
    memberHuids: [MY_HUID, NAMELESS_PEER_HUID],
    updatedAt: '2026-09-08T07:03:00.000000Z',
  }),
  makeRawChat({
    chatId: GROUP_CHAT_ID,
    name: 'Дежурка',
    chatType: 'group_chat',
    memberHuids: [MY_HUID, PEER_HUID, SECOND_PEER_HUID],
    updatedAt: '2026-09-08T07:02:00.000000Z',
  }),
];

let ring: KeyRing;
let server: ToolServer;
let historyEvents: Record<string, unknown>[];

async function buildHistory(): Promise<Record<string, unknown>[]> {
  const common = {
    groupChatId: PERSONAL_CHAT_ID,
    sender: PEER_HUID,
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
        from: PEER_HUID,
        timestamp: '2026-09-08T07:01:00.000Z',
        groupChatId: PERSONAL_CHAT_ID,
        body: `@{mention:${MENTION_ID}} посмотри, пожалуйста`,
        mentions: [{ mentionId: MENTION_ID, huid: MY_HUID, name: 'Заказчиков Заказ' }],
      }),
    }),
    await makeHistoryEvent({
      ...common,
      syncId: syncId(2),
      insertedAt: '2026-09-08T07:02:00.000Z',
      inner: makeInnerLink({
        msgId: syncId(2),
        from: PEER_HUID,
        timestamp: '2026-09-08T07:02:00.000Z',
        groupChatId: PERSONAL_CHAT_ID,
        body: 'вот отчёт',
        url: 'https://example.test/отчёт',
      }),
    }),
  ];
}

beforeAll(async () => {
  await sodium.ready;
  ring = await makeKeyRing();
});

beforeEach(async () => {
  historyEvents = await buildHistory();
  server = await startToolServer({
    ring,
    chats: CHATS,
    profiles: PROFILES,
    myHuid: MY_HUID,
  });
  server.mock.respondTo(EVENTS_HISTORY_EVENT, (frame) => {
    const payload = frame.payload as Record<string, unknown>;
    return {
      status: 'ok',
      response: {
        history:
          payload['group_chat_id'] === PERSONAL_CHAT_ID ? [...historyEvents].reverse() : [],
      },
    };
  });
});

afterEach(async () => {
  await server.close();
});

describe('list_chats и имена собеседников', () => {
  it('личные чаты называются именами собеседников и несут их адрес и профиль', async () => {
    const payload = await server.callTool<ListChatsResult>('list_chats', {});

    const first = payload.chats.find((chat) => chat.chat_id === PERSONAL_CHAT_ID);
    const second = payload.chats.find((chat) => chat.chat_id === SECOND_PERSONAL_CHAT_ID);

    expect(first?.name).toBe('Тестов Тест Тестович');
    expect(first?.peer_huid).toBe(PEER_HUID);
    expect(first?.peer).toEqual({
      name: 'Тестов Тест Тестович',
      company_position: 'Главный инженер',
      department: 'Отдел проб',
    });
    expect(second?.name).toBe('Пробова Проба Пробовна');
    expect(second?.peer_huid).toBe(SECOND_PEER_HUID);
  });

  /* Придумать имя нельзя: huid это адрес, а не имя человека */
  it('чат без профиля остаётся с серверным именем, но получает адрес собеседника', async () => {
    const payload = await server.callTool<ListChatsResult>('list_chats', {});
    const nameless = payload.chats.find((chat) => chat.chat_id === NAMELESS_CHAT_ID);

    expect(nameless?.name).toBe('personal chat');
    expect(nameless?.peer_huid).toBe(NAMELESS_PEER_HUID);
    expect(nameless?.peer).toBeUndefined();
  });

  it('групповой чат ни имени, ни адреса собеседника не получает', async () => {
    const payload = await server.callTool<ListChatsResult>('list_chats', {});
    const group = payload.chats.find((chat) => chat.chat_id === GROUP_CHAT_ID);

    expect(group?.name).toBe('Дежурка');
    expect(group?.peer_huid).toBeUndefined();
  });

  it('список участников чата наружу не уходит ни в каком виде', async () => {
    const payload = await server.callTool<ListChatsResult>('list_chats', {});
    const serialized = JSON.stringify(payload);

    expect(serialized).not.toContain('member_huids');
    expect(serialized).not.toContain(MY_HUID);
  });

  it('имена всего списка стоят ОДНОГО обращения, а второй вызов берёт их из кэша', async () => {
    await server.callTool<ListChatsResult>('list_chats', {});
    await server.callTool<ListChatsResult>('list_chats', {});

    expect(server.profileRequests).toHaveLength(1);
    expect(server.profileRequests[0]?.sort()).toEqual(
      [PEER_HUID, SECOND_PEER_HUID, NAMELESS_PEER_HUID].sort(),
    );
  });
});

describe('search по людям', () => {
  it('человек находится по фамилии собеседника и адресуется чатом с ним', async () => {
    const payload = await server.callTool<SearchResult>('search', { query: 'Тестов' });

    expect(payload.users).toEqual([
      {
        name: 'Тестов Тест Тестович',
        chat_id: PERSONAL_CHAT_ID,
        kind: 'chat',
        company_position: 'Главный инженер',
        department: 'Отдел проб',
      },
    ]);
    expect(payload.chats?.map((chat) => chat.chat_id)).toEqual([PERSONAL_CHAT_ID]);
  });

  it('неполнота выдачи людей объявлена причиной, а не спрятана', async () => {
    const payload = await server.callTool<SearchResult>('search', {
      query: 'Тестов',
      entities: ['users'],
    });

    expect(payload.partial).toBe(true);
    expect(payload.partial_reason).toContain('глобального серверного поиска людей нет');
  });

  it('люди находятся и по подразделению, а не только по имени', async () => {
    const payload = await server.callTool<SearchResult>('search', {
      query: 'отдел проб',
      entities: ['users'],
    });

    expect(payload.users?.map((user) => user.chat_id)).toEqual([
      PERSONAL_CHAT_ID,
      SECOND_PERSONAL_CHAT_ID,
    ]);
  });
});

describe('get_history по имени человека', () => {
  it('запрос фамилией собеседника резолвит его личный чат', async () => {
    const payload = await server.callTool<GetHistoryResult>('get_history', { chat: 'Тестович' });

    expect(payload.status).toBe('ok');
    expect(payload.status === 'ok' && payload.chat_id).toBe(PERSONAL_CHAT_ID);
    expect(payload.status === 'ok' && payload.messages).toHaveLength(2);
  });

  it('порядок слов запроса не мешает: «Имя Фамилия» находит «Фамилия Имя»', async () => {
    const payload = await server.callTool<GetHistoryResult>('get_history', {
      chat: 'Тест Тестов',
    });

    expect(payload.status === 'ok' && payload.chat_id).toBe(PERSONAL_CHAT_ID);
  });

  it('имя чата в сообщениях это имя собеседника, а не серверная заглушка', async () => {
    const payload = await server.callTool<GetHistoryResult>('get_history', { chat: 'Тестович' });
    if (payload.status !== 'ok') {
      throw new Error(`история отдала статус ${payload.status}`);
    }

    expect(payload.messages[0]?.chat_name).toBe('Тестов Тест Тестович');
  });

  it('сообщение со ссылкой несёт и текст, и адрес ссылки', async () => {
    const payload = await server.callTool<GetHistoryResult>('get_history', { chat: 'Тестович' });
    if (payload.status !== 'ok') {
      throw new Error(`история отдала статус ${payload.status}`);
    }
    const link = payload.messages.find((message) => message.type === 'link');

    expect(link?.text).toBe('вот отчёт');
    expect(link?.link).toEqual({ url: 'https://example.test/отчёт' });
  });

  it('упоминание подставлено именем, а адресат уехал отдельным списком', async () => {
    const payload = await server.callTool<GetHistoryResult>('get_history', { chat: 'Тестович' });
    if (payload.status !== 'ok') {
      throw new Error(`история отдала статус ${payload.status}`);
    }
    const mentioning = payload.messages[0];

    expect(mentioning?.text).toBe('@Заказчиков Заказ посмотри, пожалуйста');
    expect(mentioning?.mentions).toEqual([{ huid: MY_HUID, name: 'Заказчиков Заказ' }]);
  });
});
