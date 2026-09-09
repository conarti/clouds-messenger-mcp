/**
 * Форма чата и ПРЕДПОСЫЛКА, на которой стоит вся адресация: `chat_id` это единый UUID
 * сервера и ничто иное.
 *
 * Проверка склейки идентификаторов участников не декоративна. У предыдущего мессенджера
 * приватный чат адресовался парой guid, и перенос той привычки сюда дал бы адрес, которого
 * на сервере нет: чат нашёлся бы «никогда», причём молча.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeAuthProvider } from '../../src/auth/FakeAuthProvider.js';
import {
  normalizeChat,
  normalizeChats,
  resolvePeerNames,
  sortChatsByFreshness,
  toPublicChat,
  type ChatRecord,
  type PeerNamesDeps,
} from '../../src/protocol/chatShape.js';
import { UUID_PATTERN } from '../../src/protocol/messageShape.js';
import { resetProfileCache } from '../../src/protocol/profiles.js';
import { createLogger } from '../../src/util/logger.js';
import { FakeProfilesRest } from '../helpers/fakeRest.js';
import {
  makeRawChat,
  MY_HUID,
  NAMELESS_PEER_HUID,
  OTHER_CHAT_ID,
  PEER_HUID,
  POLYGON_CHAT_ID,
  type ProfileFixture,
} from '../helpers/readFixtures.js';
import { createTestConfig } from '../helpers/testConfig.js';

function collectSources(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      return collectSources(path);
    }
    return path.endsWith('.ts') ? [path] : [];
  });
}

describe('нормализация чата', () => {
  it('берёт chat_id из group_chat_id как есть и держит вид строкой', () => {
    const record = normalizeChat(
      makeRawChat({ chatId: POLYGON_CHAT_ID, name: 'Избранное', chatType: 'notes' }),
    );

    expect(record?.chat_id).toBe(POLYGON_CHAT_ID);
    expect(record?.chat_id).toMatch(UUID_PATTERN);
    expect(record?.kind).toBe('notes');
    expect(record?.is_self).toBe(true);
  });

  it('переносит метаданные и ключи получателей, а вид чата не сужает', () => {
    const record = normalizeChat(
      makeRawChat({
        chatId: OTHER_CHAT_ID,
        name: 'Дежурка',
        chatType: 'group_chat',
        membersCount: 7,
        updatedAt: '2026-09-08T07:14:30.370000Z',
        pinnedSyncId: '11111111-1111-4111-8111-111111111111',
        keys: ['recipient-key-id-a', 'recipient-key-id-b'],
      }),
    );

    expect(record?.name).toBe('Дежурка');
    expect(record?.kind).toBe('group_chat');
    expect(record?.members_count).toBe(7);
    expect(record?.last_activity).toBe('2026-09-08T07:14:30.370Z');
    expect(record?.pinned_message_id).toBe('11111111-1111-4111-8111-111111111111');
    expect(record?.key_ids).toEqual(['recipient-key-id-a', 'recipient-key-id-b']);
    expect(record?.is_self).toBe(false);
  });

  it('не отдаёт запись, которую нечем адресовать', () => {
    expect(normalizeChat({ chat_type: 'chat', name: 'без адреса' })).toBeUndefined();
    expect(normalizeChats([{ chat_type: 'chat' }, makeRawChat({ chatId: POLYGON_CHAT_ID })])).toHaveLength(1);
  });

  it('свежие первыми, а чат без метки уходит в хвост, а не в голову', () => {
    const sorted = sortChatsByFreshness(
      normalizeChats([
        makeRawChat({ chatId: OTHER_CHAT_ID, updatedAt: '2026-09-01T00:00:00.000000Z' }),
        { group_chat_id: '00000000-0000-4000-8000-000000000001', chat_type: 'chat' },
        makeRawChat({ chatId: POLYGON_CHAT_ID, updatedAt: '2026-09-08T00:00:00.000000Z' }),
      ]),
    );

    expect(sorted.map((chat) => chat.chat_id)).toEqual([
      POLYGON_CHAT_ID,
      OTHER_CHAT_ID,
      '00000000-0000-4000-8000-000000000001',
    ]);
  });
});

describe('публичная выдача чата', () => {
  it('несёт непрочитанное парой число плюс флаг и НЕ несёт ключевого материала', () => {
    const record = normalizeChat(makeRawChat({ chatId: POLYGON_CHAT_ID, name: 'Дежурка' }));
    expect(record).toBeDefined();
    const chat = toPublicChat(record!, 4);

    expect(chat.unread_count).toBe(4);
    expect(chat.unread).toBe(true);
    expect(Object.keys(chat)).not.toContain('key_ids');
    expect(JSON.stringify(chat)).not.toContain('recipient-key-id');
  });

  it('нулевое непрочитанное это не «непрочитано»', () => {
    const record = normalizeChat(makeRawChat({ chatId: POLYGON_CHAT_ID }));
    expect(toPublicChat(record!, 0).unread).toBe(false);
  });
});

const PROFILES: ProfileFixture[] = [
  {
    huid: PEER_HUID,
    name: 'Тестов Тест Тестович',
    companyPosition: 'Инженер',
    department: 'Отдел проб',
  },
];

interface PeerProbe {
  deps: PeerNamesDeps;
  rest: FakeProfilesRest;
  auth: FakeAuthProvider;
}

function createPeerProbe(): PeerProbe {
  const rest = new FakeProfilesRest(PROFILES);
  const auth = new FakeAuthProvider({ huid: MY_HUID });
  return {
    rest,
    auth,
    deps: { rest, auth, config: createTestConfig(), logger: createLogger({ level: 'error' }) },
  };
}

function personalChat(chatId: string, memberHuids: string[]): ChatRecord {
  const record = normalizeChat(
    makeRawChat({ chatId, name: 'personal chat', chatType: 'chat', memberHuids }),
  );
  if (record === undefined) {
    throw new Error('фикстура личного чата не нормализовалась');
  }
  return record;
}

beforeEach(() => {
  resetProfileCache();
});

describe('участники чата', () => {
  it('нормализация переносит member_huids внутрь записи', () => {
    const record = normalizeChat(
      makeRawChat({ chatId: POLYGON_CHAT_ID, chatType: 'chat', memberHuids: [MY_HUID, PEER_HUID] }),
    );

    expect(record?.member_huids).toEqual([MY_HUID, PEER_HUID]);
  });

  it('публичная выдача участников НЕ несёт: список людей чата наружу не уходит', () => {
    const record = personalChat(POLYGON_CHAT_ID, [MY_HUID, PEER_HUID]);

    const chat = toPublicChat(record, 0);

    expect(Object.keys(chat)).not.toContain('member_huids');
    expect(JSON.stringify(chat)).not.toContain(PEER_HUID);
  });
});

describe('имена собеседников личных чатов', () => {
  it('подставляет имя профиля вместо серверной заглушки и несёт адрес с профилем', async () => {
    const probe = createPeerProbe();

    const [resolved] = await resolvePeerNames(probe.deps, [
      personalChat(POLYGON_CHAT_ID, [MY_HUID, PEER_HUID]),
    ]);

    expect(resolved?.name).toBe('Тестов Тест Тестович');
    expect(resolved?.peer_huid).toBe(PEER_HUID);
    expect(resolved?.peer).toEqual({
      name: 'Тестов Тест Тестович',
      company_position: 'Инженер',
      department: 'Отдел проб',
    });
  });

  it('имя и профиль собеседника доезжают до публичной выдачи', async () => {
    const probe = createPeerProbe();

    const [resolved] = await resolvePeerNames(probe.deps, [
      personalChat(POLYGON_CHAT_ID, [MY_HUID, PEER_HUID]),
    ]);
    const chat = toPublicChat(resolved!, 0);

    expect(chat.name).toBe('Тестов Тест Тестович');
    expect(chat.peer_huid).toBe(PEER_HUID);
    expect(chat.peer?.company_position).toBe('Инженер');
  });

  /* Придумать имя нельзя: huid это адрес, а не имя человека */
  it('без профиля имя остаётся серверным, а рядом появляется адрес собеседника', async () => {
    const probe = createPeerProbe();

    const [resolved] = await resolvePeerNames(probe.deps, [
      personalChat(OTHER_CHAT_ID, [MY_HUID, NAMELESS_PEER_HUID]),
    ]);

    expect(resolved?.name).toBe('personal chat');
    expect(resolved?.peer_huid).toBe(NAMELESS_PEER_HUID);
    expect(resolved?.peer).toBeUndefined();
  });

  it('групповой чат не трогается и в справку не попадает', async () => {
    const probe = createPeerProbe();
    const group = normalizeChat(
      makeRawChat({
        chatId: OTHER_CHAT_ID,
        name: 'Дежурка',
        chatType: 'group_chat',
        memberHuids: [MY_HUID, PEER_HUID],
      }),
    );

    const resolved = await resolvePeerNames(probe.deps, [
      group!,
      personalChat(POLYGON_CHAT_ID, [MY_HUID, PEER_HUID]),
    ]);

    expect(resolved[0]?.name).toBe('Дежурка');
    expect(resolved[0]?.peer_huid).toBeUndefined();
    expect(probe.rest.calls[0]?.huids).toEqual([PEER_HUID]);
  });

  it('без личных чатов справка не спрашивается и своя идентичность не читается', async () => {
    const probe = createPeerProbe();
    const group = normalizeChat(
      makeRawChat({ chatId: OTHER_CHAT_ID, name: 'Дежурка', chatType: 'group_chat' }),
    );

    await resolvePeerNames(probe.deps, [group!]);

    expect(probe.rest.calls).toHaveLength(0);
    expect(probe.auth.calls.getWhoami).toBe(0);
  });

  it('чат не на двоих собеседника не даёт: гадать, кто из троих, нечем', async () => {
    const probe = createPeerProbe();

    const [resolved] = await resolvePeerNames(probe.deps, [
      personalChat(POLYGON_CHAT_ID, [MY_HUID, PEER_HUID, NAMELESS_PEER_HUID]),
    ]);

    expect(resolved?.name).toBe('personal chat');
    expect(resolved?.peer_huid).toBeUndefined();
    expect(probe.rest.calls).toHaveLength(0);
  });

  it('весь список спрашивается одним обращением, а не по чату за раз', async () => {
    const probe = createPeerProbe();

    await resolvePeerNames(probe.deps, [
      personalChat(POLYGON_CHAT_ID, [MY_HUID, PEER_HUID]),
      personalChat(OTHER_CHAT_ID, [MY_HUID, NAMELESS_PEER_HUID]),
    ]);

    expect(probe.rest.calls).toHaveLength(1);
    expect(probe.rest.calls[0]?.huids).toEqual([PEER_HUID, NAMELESS_PEER_HUID]);
  });
});

describe('предпосылка: адрес чата не конструируется', () => {
  const sources = [...collectSources('src/chat'), ...collectSources('src/protocol')];

  it('в src/chat и src/protocol нет склейки идентификаторов участников', () => {
    const offenders = sources.filter((path) => {
      const source = readFileSync(path, 'utf8');
      return /\$\{[^}]*huid/i.test(source) || /_\$\{/.test(source);
    });

    expect(offenders).toEqual([]);
  });

  it('проверка смотрит на непустой набор файлов', () => {
    expect(sources.length).toBeGreaterThan(0);
  });
});
