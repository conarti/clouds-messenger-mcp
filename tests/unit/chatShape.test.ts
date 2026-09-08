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
import { describe, expect, it } from 'vitest';
import {
  normalizeChat,
  normalizeChats,
  sortChatsByFreshness,
  toPublicChat,
} from '../../src/protocol/chatShape.js';
import { UUID_PATTERN } from '../../src/protocol/messageShape.js';
import { makeRawChat, OTHER_CHAT_ID, POLYGON_CHAT_ID } from '../helpers/readFixtures.js';

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
