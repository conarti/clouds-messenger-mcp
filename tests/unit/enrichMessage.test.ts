/**
 * Обогащение аддитивно: проверка золотым надмножеством.
 *
 * Утверждение здесь ровно одно, зато сильное: обогащённое сообщение содержит ВСЕ ключи и
 * ВСЕ значения базового. Это не придирка к стилю: тем же слоем обогащаются выдачи истории,
 * точечного чтения, окна контекста и поиска, и стоит обогащению начать переписывать поле,
 * как канал молча потеряет его, оставшись зелёным в тестах своего инструмента.
 *
 * Отдельно проверяются два случая, в которых потеря была бы незаметнее всего: нерасшифрованное
 * событие (пропало бы объяснение, почему нет текста) и сообщение с вложением (пропал бы
 * единственный адрес файла).
 */
import { describe, expect, it } from 'vitest';
import type { ChatRecord } from '../../src/protocol/chatShape.js';
import { enrichMessage, enrichMessages } from '../../src/protocol/enrichMessage.js';
import type { Message } from '../../src/protocol/messageShape.js';
import { OTHER_CHAT_ID, POLYGON_CHAT_ID } from '../helpers/readFixtures.js';

const MESSAGE_ID = '00000000-0000-4000-8000-000000000001';
const SECOND_MESSAGE_ID = '00000000-0000-4000-8000-000000000002';

const GROUP_CHAT: ChatRecord = {
  chat_id: OTHER_CHAT_ID,
  name: 'Дежурка',
  kind: 'group_chat',
  members_count: 2,
  key_ids: ['recipient-key-id-a', 'recipient-key-id-b'],
  is_self: false,
};

const SELF_CHAT: ChatRecord = {
  chat_id: POLYGON_CHAT_ID,
  name: 'Избранное',
  kind: 'notes',
  key_ids: ['recipient-key-id-a'],
  is_self: true,
};

const NAMELESS_CHAT: ChatRecord = {
  chat_id: OTHER_CHAT_ID,
  kind: 'chat',
  key_ids: [],
  is_self: false,
};

const TEXT_MESSAGE: Message = {
  message_id: MESSAGE_ID,
  chat_id: OTHER_CHAT_ID,
  from: '33333333-3333-5333-8333-333333333333',
  timestamp: '2026-09-08T07:01:00.000Z',
  event_type: 'message_new',
  type: 'text',
  text: 'первое сообщение',
  reactions: [{ emoji: '✅', count: 1, mine: true }],
  read_by_count: 2,
};

const UNREADABLE_MESSAGE: Message = {
  message_id: SECOND_MESSAGE_ID,
  chat_id: OTHER_CHAT_ID,
  event_type: 'message_new',
  decrypt_error: '[client] decrypt_wrap: обёртка контент-ключа не открылась',
};

const ATTACHMENT_MESSAGE: Message = {
  message_id: MESSAGE_ID,
  chat_id: OTHER_CHAT_ID,
  timestamp: '2026-09-08T07:03:00.000Z',
  event_type: 'message_new',
  type: 'image',
  attachments: [
    {
      file_id: 'c0ffee00-0000-4000-8000-000000000001',
      file_name: 'снимок.png',
      file_size: 155_380,
      file_mime_type: 'image/png',
      has_preview: true,
    },
  ],
};

/** Золотое надмножество: каждый ключ базы присутствует и несёт то же значение */
function expectSuperset(base: Message, enriched: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(base)) {
    expect(Object.keys(enriched)).toContain(key);
    expect(enriched[key]).toEqual(value);
  }
}

describe('аддитивность обогащения', () => {
  it('текстовое сообщение доезжает целиком, а сверху ложится контекст чата', () => {
    const enriched = enrichMessage(TEXT_MESSAGE, GROUP_CHAT);

    expectSuperset(TEXT_MESSAGE, enriched as unknown as Record<string, unknown>);
    expect(enriched.chat_name).toBe('Дежурка');
    expect(enriched.chat_kind).toBe('group_chat');
    expect(enriched.is_self_chat).toBe(false);
  });

  it('обогащение не переписывает ни адрес, ни текст, ни время', () => {
    const enriched = enrichMessage(TEXT_MESSAGE, GROUP_CHAT);

    expect(enriched.message_id).toBe(TEXT_MESSAGE.message_id);
    expect(enriched.text).toBe(TEXT_MESSAGE.text);
    expect(enriched.timestamp).toBe(TEXT_MESSAGE.timestamp);
    expect(enriched.chat_id).toBe(TEXT_MESSAGE.chat_id);
  });

  it('нерасшифрованное сообщение не теряет объяснения, почему у него нет текста', () => {
    const enriched = enrichMessage(UNREADABLE_MESSAGE, GROUP_CHAT);

    expectSuperset(UNREADABLE_MESSAGE, enriched as unknown as Record<string, unknown>);
    expect(enriched.decrypt_error).toBe(UNREADABLE_MESSAGE.decrypt_error);
    expect(enriched.chat_kind).toBe('group_chat');
  });

  it('сообщение с вложением не теряет единственного адреса файла', () => {
    const enriched = enrichMessage(ATTACHMENT_MESSAGE, GROUP_CHAT);

    expectSuperset(ATTACHMENT_MESSAGE, enriched as unknown as Record<string, unknown>);
    expect(enriched.attachments?.[0]?.file_id).toBe('c0ffee00-0000-4000-8000-000000000001');
    expect(enriched.attachments?.[0]?.has_preview).toBe(true);
  });

  it('исходное сообщение не мутируется: обогащение отдаёт новую запись', () => {
    const before = JSON.stringify(TEXT_MESSAGE);
    const enriched = enrichMessage(TEXT_MESSAGE, GROUP_CHAT);

    expect(JSON.stringify(TEXT_MESSAGE)).toBe(before);
    expect(enriched).not.toBe(TEXT_MESSAGE);
  });
});

describe('что обогащение добавляет и чего не добавляет', () => {
  it('чат с собой помечается флагом: заметки это не переписка с кем-то', () => {
    expect(enrichMessage(TEXT_MESSAGE, SELF_CHAT).is_self_chat).toBe(true);
  });

  it('чат без имени не получает пустого имени: ключа просто нет', () => {
    const enriched = enrichMessage(TEXT_MESSAGE, NAMELESS_CHAT);

    expect(Object.keys(enriched)).not.toContain('chat_name');
    expect(enriched.chat_kind).toBe('chat');
  });

  it('ключевой материал чата в сообщение не просачивается', () => {
    const enriched = enrichMessage(TEXT_MESSAGE, GROUP_CHAT);

    expect(JSON.stringify(enriched)).not.toContain('recipient-key-id');
    expect(Object.keys(enriched)).not.toContain('key_ids');
  });
});

describe('обогащение списка', () => {
  it('порядок сохраняется, а каждое сообщение остаётся надмножеством своего базового', () => {
    const base = [TEXT_MESSAGE, UNREADABLE_MESSAGE, ATTACHMENT_MESSAGE];

    const enriched = enrichMessages(base, GROUP_CHAT);

    expect(enriched).toHaveLength(base.length);
    for (const [index, message] of base.entries()) {
      expectSuperset(message, enriched[index] as unknown as Record<string, unknown>);
      expect(enriched[index]?.chat_kind).toBe('group_chat');
    }
  });
});
