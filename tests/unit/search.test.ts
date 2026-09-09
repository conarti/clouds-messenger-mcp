/**
 * `search`: поиск по списку чатов и честное признание того, чего платформа не умеет.
 *
 * Главная проверка здесь не «нашлось нужное», а «не найденное не выдано за отсутствующее»:
 * поиск по текстам сообщений обязан приезжать эскалацией, а выдача людей пометкой
 * неполноты. Пустой успех в обоих случаях был бы утверждением о переписке, которого никто
 * не проверял.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeAuthProvider } from '../../src/auth/FakeAuthProvider.js';
import { DEFAULT_LIMITS } from '../../src/config/defaults.js';
import { CHAT_LIST_EVENT, UNREAD_COUNTERS_EVENT } from '../../src/protocol/chatList.js';
import { resetProfileCache } from '../../src/protocol/profiles.js';
import { SEARCH_TOOL_DEFINITION, search, type SearchDeps } from '../../src/mcp/tools/search.js';
import type { PhoenixClient } from '../../src/transport/ws/types.js';
import { createLogger } from '../../src/util/logger.js';
import { FakeProfilesRest } from '../helpers/fakeRest.js';
import {
  makeRawChat,
  MY_HUID,
  OTHER_CHAT_ID,
  PEER_HUID,
  POLYGON_CHAT_ID,
  SECOND_PEER_HUID,
  type ProfileFixture,
} from '../helpers/readFixtures.js';
import { createTestConfig } from '../helpers/testConfig.js';

const CONTACT_CHAT_ID = '7f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const SECOND_CONTACT_CHAT_ID = '8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const PERSONAL_CHAT_ID = '9b2c3d4e-5f6a-4b7c-8d8e-0f1a2b3c4d5e';
const SECOND_PERSONAL_CHAT_ID = 'ac3d4e5f-6a7b-4c8d-89ef-1a2b3c4d5e6f';

/** Имена синтетические: фикстуры лежат в репозитории, живым именам там не место */
const PROFILES: ProfileFixture[] = [
  {
    huid: PEER_HUID,
    name: 'Тестов Тест Тестович',
    companyPosition: 'Главный бухгалтер',
    department: 'Финансы',
  },
  { huid: SECOND_PEER_HUID, name: 'Пробова Проба Пробовна', department: 'Финансы' },
];

interface Probe {
  deps: SearchDeps;
  /** События, ушедшие на сервер: ими доказывается, что лишних кадров не было */
  events: string[];
  rest: FakeProfilesRest;
}

function createProbe(chats: unknown[], counters: Record<string, number> = {}): Probe {
  const events: string[] = [];
  const ws: PhoenixClient = {
    request: (async (_topic: string, event: string, payload: unknown) => {
      events.push(event);
      if (event === CHAT_LIST_EVENT) {
        return { [CHAT_LIST_EVENT]: chats };
      }
      const requested = (payload as { group_chats: string[] }).group_chats;
      return {
        unread_counters: requested.map((chatId) => ({
          group_chat_id: chatId,
          counter: counters[chatId] ?? 0,
        })),
      };
    }) as PhoenixClient['request'],
    close: async () => undefined,
  };
  const rest = new FakeProfilesRest(PROFILES);
  return {
    deps: {
      ws,
      rest,
      auth: new FakeAuthProvider({ huid: MY_HUID }),
      config: createTestConfig(),
      logger: createLogger({ level: 'error' }),
    },
    events,
    rest,
  };
}

/** Кэш профилей живёт на процесс, и соседние проверки не должны подсказывать друг другу */
beforeEach(() => {
  resetProfileCache();
});

const CHATS = [
  makeRawChat({
    chatId: POLYGON_CHAT_ID,
    name: 'Дежурка',
    chatType: 'group_chat',
    updatedAt: '2026-09-08T07:05:00.000000Z',
  }),
  makeRawChat({
    chatId: OTHER_CHAT_ID,
    name: 'Дежурный по смене',
    chatType: 'chat',
    updatedAt: '2026-09-07T07:00:00.000000Z',
  }),
  makeRawChat({
    chatId: CONTACT_CHAT_ID,
    name: 'Дежурный резерв',
    chatType: 'chat',
    updatedAt: '2026-09-06T07:00:00.000000Z',
  }),
  makeRawChat({
    chatId: SECOND_CONTACT_CHAT_ID,
    name: 'Бухгалтерия',
    chatType: 'chat',
    updatedAt: '2026-09-05T07:00:00.000000Z',
  }),
];

describe('поиск чатов', () => {
  it('совпадает подстрокой без учёта регистра и отдаёт свежие первыми', async () => {
    const probe = createProbe(CHATS);

    const found = await search(probe.deps, { query: 'ДЕЖУР', entities: ['chats'] });

    expect(found.status).toBe('ok');
    expect(found.query).toBe('ДЕЖУР');
    expect(found.chats?.map((chat) => chat.chat_id)).toEqual([
      POLYGON_CHAT_ID,
      OTHER_CHAT_ID,
      CONTACT_CHAT_ID,
    ]);
    expect(found.truncated).toBe(false);
  });

  it('в выдаче нет ни ключевого материала, ни текстов сообщений', async () => {
    const probe = createProbe(CHATS);

    const found = await search(probe.deps, { query: 'дежур', entities: ['chats'] });
    const serialized = JSON.stringify(found);

    expect(serialized).not.toContain('recipient-key-id');
    expect(serialized).not.toContain('last_message');
  });

  it('счётчик непрочитанного приезжает с сервера, а не подставляется нулём', async () => {
    const probe = createProbe(CHATS, { [OTHER_CHAT_ID]: 4 });

    const found = await search(probe.deps, { query: 'дежур', entities: ['chats'] });
    const contact = found.chats?.find((chat) => chat.chat_id === OTHER_CHAT_ID);

    expect(contact?.unread_count).toBe(4);
    expect(contact?.unread).toBe(true);
    expect(found.chats?.[0]?.unread).toBe(false);
    expect(probe.events).toEqual([CHAT_LIST_EVENT, UNREAD_COUNTERS_EVENT]);
  });

  it('промах это пустая выдача чатов, а не отказ', async () => {
    const probe = createProbe(CHATS);

    const found = await search(probe.deps, { query: 'склад', entities: ['chats'] });

    expect(found.status).toBe('ok');
    expect(found.chats).toEqual([]);
    expect(found.truncated).toBe(false);
  });
});

describe('поиск людей', () => {
  it('контакты выводятся только из личных чатов и несут адрес этого чата', async () => {
    const probe = createProbe(CHATS);

    const found = await search(probe.deps, { query: 'дежур', entities: ['users'] });

    expect(found.users).toEqual([
      { name: 'Дежурный по смене', chat_id: OTHER_CHAT_ID, kind: 'chat' },
      { name: 'Дежурный резерв', chat_id: CONTACT_CHAT_ID, kind: 'chat' },
    ]);
  });

  it('неполнота выдачи людей объявлена и названа причиной', async () => {
    const probe = createProbe(CHATS);

    const found = await search(probe.deps, { query: 'дежур', entities: ['users'] });

    expect(found.partial).toBe(true);
    expect(found.partial_reason).toContain('личным чатом');
    expect(found.partial_reason).toContain('глобального серверного поиска людей нет');
  });

  it('пометка неполноты висит на способе, а не на числе находок', async () => {
    const probe = createProbe(CHATS);

    const found = await search(probe.deps, { query: 'склад', entities: ['users'] });

    expect(found.users).toEqual([]);
    expect(found.partial).toBe(true);
  });

  it('без запроса людей пометки неполноты в ответе нет', async () => {
    const probe = createProbe(CHATS);

    const found = await search(probe.deps, { query: 'дежур', entities: ['chats'] });

    expect(Object.keys(found)).not.toContain('partial');
    expect(Object.keys(found)).not.toContain('partial_reason');
  });

  it('счётчики за людей не спрашиваются: непрочитанного в контакте нет', async () => {
    const probe = createProbe(CHATS);

    await search(probe.deps, { query: 'дежур', entities: ['users'] });

    expect(probe.events).toEqual([CHAT_LIST_EVENT]);
  });
});

/** Личные чаты приезжают с сервера под одним именем: имена собеседникам дают профили */
const PERSONAL_CHATS = [
  makeRawChat({
    chatId: PERSONAL_CHAT_ID,
    name: 'personal chat',
    chatType: 'chat',
    memberHuids: [MY_HUID, PEER_HUID],
    updatedAt: '2026-09-08T08:00:00.000000Z',
  }),
  makeRawChat({
    chatId: SECOND_PERSONAL_CHAT_ID,
    name: 'personal chat',
    chatType: 'chat',
    memberHuids: [MY_HUID, SECOND_PEER_HUID],
    updatedAt: '2026-09-08T07:30:00.000000Z',
  }),
];

describe('поиск людей по именам собеседников', () => {
  it('человек находится по имени собеседника, а не по серверной заглушке имени чата', async () => {
    const probe = createProbe(PERSONAL_CHATS);

    const found = await search(probe.deps, { query: 'тестов', entities: ['users'] });

    expect(found.users).toEqual([
      {
        name: 'Тестов Тест Тестович',
        chat_id: PERSONAL_CHAT_ID,
        kind: 'chat',
        company_position: 'Главный бухгалтер',
        department: 'Финансы',
      },
    ]);
  });

  it('человек находится по должности и по подразделению', async () => {
    const byPosition = await search(createProbe(PERSONAL_CHATS).deps, {
      query: 'бухгалтер',
      entities: ['users'],
    });
    const byDepartment = await search(createProbe(PERSONAL_CHATS).deps, {
      query: 'финансы',
      entities: ['users'],
    });

    expect(byPosition.users?.map((user) => user.chat_id)).toEqual([PERSONAL_CHAT_ID]);
    expect(byDepartment.users?.map((user) => user.chat_id)).toEqual([
      PERSONAL_CHAT_ID,
      SECOND_PERSONAL_CHAT_ID,
    ]);
  });

  it('чат тоже совпадает по имени собеседника и несёт его адрес и профиль', async () => {
    const probe = createProbe(PERSONAL_CHATS);

    const found = await search(probe.deps, { query: 'пробова', entities: ['chats'] });

    expect(found.chats?.map((chat) => chat.chat_id)).toEqual([SECOND_PERSONAL_CHAT_ID]);
    expect(found.chats?.[0]?.name).toBe('Пробова Проба Пробовна');
    expect(found.chats?.[0]?.peer_huid).toBe(SECOND_PEER_HUID);
    expect(found.chats?.[0]?.peer?.department).toBe('Финансы');
  });

  it('справка об именах спрашивается одним обращением на весь список', async () => {
    const probe = createProbe(PERSONAL_CHATS);

    await search(probe.deps, { query: 'тестов' });

    expect(probe.rest.calls).toHaveLength(1);
    expect(probe.rest.calls[0]?.huids.sort()).toEqual([PEER_HUID, SECOND_PEER_HUID].sort());
  });

  it('чат без личного собеседника ни адреса человека, ни профиля не получает', async () => {
    const probe = createProbe(CHATS);

    const found = await search(probe.deps, { query: 'дежурка', entities: ['chats'] });

    expect(found.chats?.[0]?.peer_huid).toBeUndefined();
    expect(found.chats?.[0]?.peer).toBeUndefined();
    expect(probe.rest.calls).toHaveLength(0);
  });
});

describe('поиск по текстам сообщений', () => {
  it('отдаёт эскалацию с причиной и следующим шагом, а не пустой успех', async () => {
    const probe = createProbe(CHATS);

    const found = await search(probe.deps, { query: 'смена', entities: ['messages'] });

    expect(found.status).toBe('ok');
    expect(found.escalation?.reason).toBe('поиск по текстам сообщений не поддерживается платформенно');
    expect(found.escalation?.next_step).toContain('list_chats');
    expect(found.escalation?.next_step).toContain('get_history');
    expect(Object.keys(found)).not.toContain('messages');
  });

  it('за эскалацией к серверу не ходит', async () => {
    const probe = createProbe(CHATS);

    await search(probe.deps, { query: 'смена', entities: ['messages'] });

    expect(probe.events).toEqual([]);
  });

  it('эскалация не мешает остальным выдачам того же вызова', async () => {
    const probe = createProbe(CHATS);

    const found = await search(probe.deps, {
      query: 'дежур',
      entities: ['messages', 'chats', 'users'],
    });

    expect(found.escalation).toBeDefined();
    expect(found.chats).toHaveLength(3);
    expect(found.users).toHaveLength(2);
  });
});

describe('дефолты и лимит', () => {
  it('без entities ищет людей и чаты, но не заявляет поиск по сообщениям', async () => {
    const probe = createProbe(CHATS);

    const found = await search(probe.deps, { query: 'дежур' });

    expect(found.chats).toBeDefined();
    expect(found.users).toBeDefined();
    expect(found.escalation).toBeUndefined();
  });

  it('лимит режет каждую выдачу и поднимает флаг усечения', async () => {
    const probe = createProbe(CHATS);

    const found = await search(probe.deps, { query: 'дежур', limit: 1 });

    expect(found.chats).toHaveLength(1);
    expect(found.users).toHaveLength(1);
    expect(found.truncated).toBe(true);
  });

  it('усечение одной выдачи объявляется, даже если вторая уместилась целиком', async () => {
    const probe = createProbe(CHATS);

    const found = await search(probe.deps, { query: 'дежур', limit: 2 });

    expect(found.chats).toHaveLength(2);
    expect(found.users).toHaveLength(2);
    expect(found.truncated).toBe(true);
  });

  it('пустой запрос не выдаёт весь список чатов за находку', async () => {
    const probe = createProbe(CHATS);

    const found = await search(probe.deps, { query: '   ' });

    expect(found.chats).toEqual([]);
    expect(found.users).toEqual([]);
  });
});

describe('определение инструмента', () => {
  it('объявлено только чтение и названы все три параметра', () => {
    expect(SEARCH_TOOL_DEFINITION.annotations.readOnlyHint).toBe(true);
    expect(Object.keys(SEARCH_TOOL_DEFINITION.inputSchema)).toEqual(['query', 'entities', 'limit']);
  });

  it('дефолт лимита напечатан тем же числом, которым подставляется', () => {
    expect(SEARCH_TOOL_DEFINITION.inputSchema.limit.description).toContain(
      String(DEFAULT_LIMITS.searchDefaultLimit),
    );
  });

  it('описание называет обе границы: людей ищем неполно, сообщения не ищем вовсе', () => {
    expect(SEARCH_TOOL_DEFINITION.description).toContain('partial');
    expect(SEARCH_TOOL_DEFINITION.description).toContain('escalation');
  });

  it('чужая сущность отвергается схемой, а не молча игнорируется', () => {
    expect(SEARCH_TOOL_DEFINITION.inputSchema.entities.safeParse(['contacts']).success).toBe(false);
    expect(SEARCH_TOOL_DEFINITION.inputSchema.entities.safeParse(['users', 'chats']).success).toBe(true);
  });
});
