/**
 * Адресация чата: три исхода и отказ гадать.
 *
 * Неоднозначность проверяется отдельно от промаха намеренно: соблазн «взять самый свежий
 * из совпавших» выглядит удобством на чтении и превращается в сообщение не тому человеку,
 * как только тем же резолвом начинает пользоваться отправка.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeAuthProvider } from '../../src/auth/FakeAuthProvider.js';
import { resolveChat, type ResolveChatDeps } from '../../src/chat/resolveChat.js';
import { resolveFailure } from '../../src/chat/resolveFailure.js';
import { CHAT_LIST_EVENT } from '../../src/protocol/chatList.js';
import { resetProfileCache } from '../../src/protocol/profiles.js';
import type { PhoenixClient } from '../../src/transport/ws/types.js';
import { createLogger } from '../../src/util/logger.js';
import { FakeProfilesRest } from '../helpers/fakeRest.js';
import {
  makeRawChat,
  MY_HUID,
  NAMELESS_PEER_HUID,
  OTHER_CHAT_ID,
  PEER_HUID,
  POLYGON_CHAT_ID,
  SECOND_PEER_HUID,
  type ProfileFixture,
} from '../helpers/readFixtures.js';
import { createTestConfig } from '../helpers/testConfig.js';

const THIRD_CHAT_ID = '7f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const PERSONAL_CHAT_ID = '8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const SECOND_PERSONAL_CHAT_ID = '9b2c3d4e-5f6a-4b7c-8d8e-0f1a2b3c4d5e';
const NAMELESS_CHAT_ID = 'ac3d4e5f-6a7b-4c8d-89ef-1a2b3c4d5e6f';

/** Имена синтетические: фикстуры лежат в репозитории, живым именам там не место */
const PROFILES: ProfileFixture[] = [
  {
    huid: PEER_HUID,
    name: 'Тестов Тест Тестович',
    companyPosition: 'Инженер',
    department: 'Отдел проб',
  },
  { huid: SECOND_PEER_HUID, name: 'Тестов Пётр Петрович' },
];

function createDeps(chats: unknown[], profiles: ProfileFixture[] = PROFILES): ResolveChatDeps {
  const ws: PhoenixClient = {
    request: (async () => ({ [CHAT_LIST_EVENT]: chats })) as PhoenixClient['request'],
    close: async () => undefined,
  };
  return {
    ws,
    rest: new FakeProfilesRest(profiles),
    auth: new FakeAuthProvider({ huid: MY_HUID }),
    config: createTestConfig(),
    logger: createLogger({ level: 'error' }),
  };
}

const CHATS = [
  makeRawChat({ chatId: POLYGON_CHAT_ID, name: 'Избранное', chatType: 'notes' }),
  makeRawChat({ chatId: OTHER_CHAT_ID, name: 'Дежурка', chatType: 'group_chat' }),
  makeRawChat({ chatId: THIRD_CHAT_ID, name: 'Дежурка резерв', chatType: 'group_chat' }),
];

/** Личные чаты приезжают с сервера под одним и тем же именем: имена дают профили */
const PERSONAL_CHATS = [
  makeRawChat({
    chatId: PERSONAL_CHAT_ID,
    name: 'personal chat',
    chatType: 'chat',
    memberHuids: [MY_HUID, PEER_HUID],
  }),
  makeRawChat({
    chatId: SECOND_PERSONAL_CHAT_ID,
    name: 'personal chat',
    chatType: 'chat',
    memberHuids: [MY_HUID, SECOND_PEER_HUID],
  }),
  makeRawChat({
    chatId: NAMELESS_CHAT_ID,
    name: 'personal chat',
    chatType: 'chat',
    memberHuids: [MY_HUID, NAMELESS_PEER_HUID],
  }),
];

/** Кэш профилей живёт на процесс, и соседние проверки не должны подсказывать друг другу */
beforeEach(() => {
  resetProfileCache();
});

describe('адресация идентификатором', () => {
  it('точное совпадение UUID даёт разрешение без поиска по имени', async () => {
    const resolved = await resolveChat(createDeps(CHATS), OTHER_CHAT_ID);

    expect(resolved.kind).toBe('resolved');
    expect(resolved.kind === 'resolved' && resolved.chat.chat_id).toBe(OTHER_CHAT_ID);
  });

  it('регистр идентификатора не мешает совпадению', async () => {
    const resolved = await resolveChat(createDeps(CHATS), OTHER_CHAT_ID.toUpperCase());
    expect(resolved.kind).toBe('resolved');
  });

  it('незнакомый UUID это промах с причиной, а не поиск по подстроке', async () => {
    const resolved = await resolveChat(createDeps(CHATS), '00000000-0000-4000-8000-00000000dead');

    expect(resolved.kind).toBe('not_found');
    expect(resolved.kind === 'not_found' && resolved.reason).toContain('нет такого чата в списке');
  });
});

describe('алиасы чата с собой', () => {
  it('все объявленные имена ведут в чат типа notes', async () => {
    for (const alias of ['Избранное', 'заметки', 'notes', 'saved messages', 'СЕБЕ', 'я', 'me']) {
      const resolved = await resolveChat(createDeps(CHATS), alias);

      expect(resolved.kind).toBe('resolved');
      expect(resolved.kind === 'resolved' && resolved.chat.chat_id).toBe(POLYGON_CHAT_ID);
      expect(resolved.kind === 'resolved' && resolved.chat.is_self).toBe(true);
    }
  });

  it('без чата с собой алиас даёт промах с объяснением, а не пустую выдачу', async () => {
    const resolved = await resolveChat(createDeps([CHATS[1], CHATS[2]]), 'избранное');

    expect(resolved.kind).toBe('not_found');
    expect(resolved.kind === 'not_found' && resolved.reason).toContain('чата с собой');
  });
});

describe('адресация именем', () => {
  it('точное имя без учёта регистра старше подстроки', async () => {
    const resolved = await resolveChat(createDeps(CHATS), 'дежурка');

    expect(resolved.kind).toBe('resolved');
    expect(resolved.kind === 'resolved' && resolved.chat.chat_id).toBe(OTHER_CHAT_ID);
  });

  it('единственная подстрока это разрешение', async () => {
    const resolved = await resolveChat(createDeps(CHATS), 'резерв');

    expect(resolved.kind).toBe('resolved');
    expect(resolved.kind === 'resolved' && resolved.chat.chat_id).toBe(THIRD_CHAT_ID);
  });

  it('несколько подстрок это неоднозначность со всеми кандидатами и без выбора', async () => {
    const resolved = await resolveChat(createDeps(CHATS), 'дежур');

    expect(resolved.kind).toBe('ambiguous');
    expect(resolved.kind === 'ambiguous' && resolved.candidates).toEqual([
      { chat_id: OTHER_CHAT_ID, name: 'Дежурка', kind: 'group_chat' },
      { chat_id: THIRD_CHAT_ID, name: 'Дежурка резерв', kind: 'group_chat' },
    ]);
  });

  it('ноль совпадений это промах, а пустой запрос это промах ещё до списка', async () => {
    expect((await resolveChat(createDeps(CHATS), 'бухгалтерия')).kind).toBe('not_found');
    expect((await resolveChat(createDeps(CHATS), '   ')).kind).toBe('not_found');
  });
});

describe('адресация именем человека', () => {
  it('личный чат находится по фамилии собеседника, а не по серверной заглушке имени', async () => {
    const resolved = await resolveChat(createDeps(PERSONAL_CHATS), 'Тестович');

    expect(resolved.kind).toBe('resolved');
    expect(resolved.kind === 'resolved' && resolved.chat.chat_id).toBe(PERSONAL_CHAT_ID);
  });

  it('порядок слов не мешает: запрос «Имя Фамилия» находит имя «Фамилия Имя»', async () => {
    const resolved = await resolveChat(createDeps(PERSONAL_CHATS), 'Тест Тестов');

    expect(resolved.kind).toBe('resolved');
    expect(resolved.kind === 'resolved' && resolved.chat.chat_id).toBe(PERSONAL_CHAT_ID);
  });

  it('общая фамилия это неоднозначность с именами кандидатов, а не выбор свежего', async () => {
    const resolved = await resolveChat(createDeps(PERSONAL_CHATS), 'Тестов');

    expect(resolved.kind).toBe('ambiguous');
    expect(resolved.kind === 'ambiguous' && resolved.candidates).toEqual([
      { chat_id: PERSONAL_CHAT_ID, name: 'Тестов Тест Тестович', kind: 'chat' },
      { chat_id: SECOND_PERSONAL_CHAT_ID, name: 'Тестов Пётр Петрович', kind: 'chat' },
    ]);
  });

  it('чат без профиля собеседника именем человека не адресуется и остаётся безымянным', async () => {
    const resolved = await resolveChat(createDeps(PERSONAL_CHATS), 'Неизвестный');

    expect(resolved.kind).toBe('not_found');
  });
});

describe('форма отказа', () => {
  it('неоднозначность уходит наружу кандидатами и инструкцией', async () => {
    const resolved = await resolveChat(createDeps(CHATS), 'дежур');
    expect(resolved.kind).toBe('ambiguous');
    if (resolved.kind === 'resolved') {
      throw new Error('ожидалась неоднозначность');
    }
    const failure = resolveFailure(resolved);

    expect(failure.status).toBe('ambiguous_chat');
    expect(failure.status === 'ambiguous_chat' && failure.candidates).toHaveLength(2);
    expect(failure.next_step.length).toBeGreaterThan(0);
  });

  it('промах уходит наружу причиной и инструкцией', async () => {
    const resolved = await resolveChat(createDeps(CHATS), 'бухгалтерия');
    if (resolved.kind === 'resolved') {
      throw new Error('ожидался промах');
    }
    const failure = resolveFailure(resolved);

    expect(failure.status).toBe('chat_not_found');
    expect(failure.status === 'chat_not_found' && failure.reason).toContain('бухгалтерия');
    expect(failure.next_step).toContain('list_chats');
  });
});
