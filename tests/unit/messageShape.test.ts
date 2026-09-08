/**
 * Единая форма сообщения и ПРЕДПОСЫЛКА адресации: `message_id` это `sync_id`, то есть UUID.
 *
 * Проверка «не число» стоит здесь не ради типа. Курсор истории и точечное чтение
 * адресуются этим значением, и стоит принять его за метку времени, как появляется
 * соблазн подвинуть границу на единицу, а это порча адреса, а не сдвиг границы.
 */
import { describe, expect, it } from 'vitest';
import { normalizeChat } from '../../src/protocol/chatShape.js';
import { enrichMessage } from '../../src/protocol/enrichMessage.js';
import { UUID_PATTERN, normalizeEvent } from '../../src/protocol/messageShape.js';
import {
  makeInnerImage,
  makeInnerText,
  makeRawChat,
  MY_HUID,
  POLYGON_CHAT_ID,
} from '../helpers/readFixtures.js';

const SYNC_ID = '9d3a1f4c-2b6e-4a70-9f01-53c0d1e2a7b4';
const MESSAGE_TEXT = 'синтетический текст пробы';

function rawEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sync_id: SYNC_ID,
    group_chat_id: POLYGON_CHAT_ID,
    event_type: 'message_new',
    inserted_at: '2026-09-08T07:14:30.370000Z',
    sender: MY_HUID,
    read_by: [],
    ...overrides,
  };
}

describe('предпосылка: адрес сообщения это UUID', () => {
  it('message_id равен sync_id и удовлетворяет образцу UUID', () => {
    const message = normalizeEvent(rawEvent());

    expect(message?.message_id).toBe(SYNC_ID);
    expect(message?.message_id).toMatch(UUID_PATTERN);
    expect(Number.isNaN(Number(message?.message_id))).toBe(true);
  });

  it('событие без адреса наружу не отдаётся', () => {
    expect(normalizeEvent({ group_chat_id: POLYGON_CHAT_ID })).toBeUndefined();
    expect(normalizeEvent({ sync_id: SYNC_ID })).toBeUndefined();
  });
});

describe('текстовое сообщение', () => {
  const inner = makeInnerText({
    msgId: '5b2c8e10-7d44-4c1a-8f9b-2a6e0c3d5f81',
    from: MY_HUID,
    timestamp: '2026-09-08T07:14:29.000Z',
    groupChatId: POLYGON_CHAT_ID,
    body: MESSAGE_TEXT,
  });

  it('берёт текст из body, автора и метку из внутреннего события', () => {
    const message = normalizeEvent(rawEvent(), { inner });

    expect(message?.text).toBe(MESSAGE_TEXT);
    expect(message?.type).toBe('text');
    expect(message?.event_type).toBe('message_new');
    expect(message?.from).toBe(MY_HUID);
    expect(message?.timestamp).toBe('2026-09-08T07:14:29.000Z');
  });

  it('текст лежит ровно в одном поле и никуда не продублирован', () => {
    const message = normalizeEvent(rawEvent(), { inner });
    const carrying = Object.entries(message ?? {}).filter(([, value]) =>
      JSON.stringify(value).includes(MESSAGE_TEXT),
    );

    expect(carrying.map(([key]) => key)).toEqual(['text']);
  });

  it('без внутреннего события текста нет, а автор и метка берутся из внешнего', () => {
    const message = normalizeEvent(rawEvent());

    expect(message?.text).toBeUndefined();
    expect(message?.type).toBeUndefined();
    expect(message?.from).toBe(MY_HUID);
    expect(message?.timestamp).toBe('2026-09-08T07:14:30.370Z');
  });
});

describe('вложение', () => {
  it('файловое событие даёт реф вложения без байтов превью', () => {
    const inner = makeInnerImage({
      msgId: '5b2c8e10-7d44-4c1a-8f9b-2a6e0c3d5f82',
      from: MY_HUID,
      timestamp: '2026-09-08T07:15:00.000Z',
      groupChatId: POLYGON_CHAT_ID,
      fileId: 'c0ffee00-0000-4000-8000-000000000001',
      fileName: 'снимок.png',
    });

    const message = normalizeEvent(rawEvent(), { inner });
    const attachment = message?.attachments?.[0];

    expect(message?.type).toBe('image');
    expect(message?.text).toBeUndefined();
    expect(attachment?.file_id).toBe('c0ffee00-0000-4000-8000-000000000001');
    expect(attachment?.file_name).toBe('снимок.png');
    expect(attachment?.file_size).toBe(155380);
    expect(attachment?.file_mime_type).toBe('image/png');
    expect(attachment?.chunk_size).toBe(2097152);
    expect(attachment?.has_preview).toBe(true);
    expect(JSON.stringify(attachment)).not.toContain('синтетическое превью');
  });
});

describe('реакции и прочтения', () => {
  it('разбирает компактную строку счётчиков и отмечает свои', () => {
    const message = normalizeEvent(
      rawEvent({
        meta: {
          activities: {
            reaction_counters: '✅:1,👍:3',
            user_reactions: { emoji: ['👍'], votes: [] },
          },
        },
      }),
    );

    expect(message?.reactions).toEqual([
      { emoji: '✅', count: 1, mine: false },
      { emoji: '👍', count: 3, mine: true },
    ]);
  });

  it('считает прочтения по длине списка, а пустой список это ноль, а не отсутствие', () => {
    expect(normalizeEvent(rawEvent())?.read_by_count).toBe(0);
    expect(normalizeEvent(rawEvent({ read_by: [{ user_huid: 'a' }, { user_huid: 'b' }] }))?.read_by_count).toBe(2);
  });

  it('без активностей поля реакций нет вовсе, а не пустого массива', () => {
    expect(normalizeEvent(rawEvent())?.reactions).toBeUndefined();
  });
});

describe('нерасшифрованное событие', () => {
  it('остаётся в выдаче с пометкой отказа и сохраняет адрес', () => {
    const message = normalizeEvent(rawEvent(), { error: '[client] decrypt: тело не открылось' });

    expect(message?.message_id).toBe(SYNC_ID);
    expect(message?.decrypt_error).toBe('[client] decrypt: тело не открылось');
    expect(message?.text).toBeUndefined();
  });
});

describe('обогащение сообщения контекстом чата', () => {
  it('только ДОБАВЛЯЕТ ключи: база сообщения остаётся целой до последнего значения', () => {
    const base = normalizeEvent(rawEvent(), {
      inner: makeInnerText({
        msgId: SYNC_ID,
        from: MY_HUID,
        timestamp: '2026-09-08T07:14:29.000Z',
        groupChatId: POLYGON_CHAT_ID,
        body: MESSAGE_TEXT,
      }),
    });
    const chat = normalizeChat(makeRawChat({ chatId: POLYGON_CHAT_ID, name: 'Избранное', chatType: 'notes' }));
    expect(base).toBeDefined();
    expect(chat).toBeDefined();

    const enriched = enrichMessage(base!, chat!);

    for (const [key, value] of Object.entries(base!)) {
      expect(enriched).toHaveProperty(key);
      expect(enriched[key as keyof typeof enriched]).toEqual(value);
    }
    expect(enriched.chat_name).toBe('Избранное');
    expect(enriched.chat_kind).toBe('notes');
    expect(enriched.is_self_chat).toBe(true);
  });
});
