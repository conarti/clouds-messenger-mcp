/**
 * Фикстуры путей чтения: сырые записи чатов и событий истории в той форме, в какой они
 * приезжают с провода.
 *
 * Формы сняты с артефактов Фазы 0: набор полей чата, внешнее событие истории
 * (`sync_id`, `key`, `payload`, `sender_key_id`, `event_type`, `inserted_at`, `meta.activities`,
 * `read_by`) и внутренние события `text` и `image`. Шифрование берётся из `cryptoFixtures`,
 * чтобы фикстура не зависела от `src/crypto` и не превращала проверку в тавтологию.
 */
import { encryptInnerEvent, type KeyPairFixture } from './cryptoFixtures.js';

export const POLYGON_CHAT_ID = '11111111-2222-4333-8444-555555555555';
export const OTHER_CHAT_ID = '22222222-3333-4444-8555-666666666666';
export const MY_HUID = '33333333-3333-5333-8333-333333333333';

/** Адрес события: `sync_id` это UUID, и порядковый номер делает фикстуры читаемыми глазами */
export function syncId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`;
}

export interface RawChatInput {
  chatId: string;
  name?: string;
  chatType?: string;
  membersCount?: number;
  updatedAt?: string;
  pinnedSyncId?: string;
  keys?: string[];
}

/** Запись чата: только поля, которые читает нормализация, плюс шум для проверки устойчивости */
export function makeRawChat(input: RawChatInput): Record<string, unknown> {
  return {
    group_chat_id: input.chatId,
    chat_type: input.chatType ?? 'chat',
    ...(input.name !== undefined ? { name: input.name } : {}),
    description: null,
    keys: input.keys ?? ['recipient-key-id-a'],
    members_count: input.membersCount ?? 2,
    member_huids: [MY_HUID],
    admin_huids: [MY_HUID],
    updated_at: input.updatedAt ?? '2026-09-08T07:00:00.000000Z',
    inserted_at: '2026-09-01T07:00:00.000000Z',
    ...(input.pinnedSyncId !== undefined ? { message_pinned_sync_id: input.pinnedSyncId } : {}),
    chat_settings: { reactions: { available_reactions: null, reactions_enabled: null } },
    threads_enabled: false,
    left: false,
    active: true,
  };
}

export function makeInnerText(input: {
  msgId: string;
  from: string;
  timestamp: string;
  groupChatId: string;
  body: string;
}): Record<string, unknown> {
  return {
    type: 'text',
    msg_id: input.msgId,
    from: input.from,
    timestamp: input.timestamp,
    group_chat_id: input.groupChatId,
    lat: 0,
    lng: 0,
    link_meta_disabled: false,
    stealth_forwarding: false,
    body: input.body,
  };
}

export function makeInnerImage(input: {
  msgId: string;
  from: string;
  timestamp: string;
  groupChatId: string;
  fileId: string;
  fileName: string;
}): Record<string, unknown> {
  return {
    type: 'image',
    msg_id: input.msgId,
    from: input.from,
    timestamp: input.timestamp,
    group_chat_id: input.groupChatId,
    lat: 0,
    lng: 0,
    stealth_forwarding: false,
    payload: {
      file: 'синтетическая ссылка на файл',
      file_name: input.fileName,
      file_size: 155380,
      file_hash: 'синтетический хеш',
      file_mime_type: 'image/png',
      chunk_size: 2097152,
      file_encryption_algo: 'stream',
      file_preview: 'синтетическое превью',
      file_preview_width: 300,
      file_preview_height: 122,
      file_id: input.fileId,
    },
  };
}

export interface HistoryEventInput {
  syncId: string;
  groupChatId: string;
  insertedAt: string;
  sender: string;
  senderKeyId: string;
  senderPrivateKey: Uint8Array;
  recipient: KeyPairFixture;
  inner: Record<string, unknown>;
  /** Компактная строка счётчиков реакций вида «эмодзи:счётчик», записи через запятую */
  reactionCounters?: string;
  myReactions?: string[];
  readByCount?: number;
}

/** Внешнее событие истории целиком: конверт из cryptoFixtures плюс поля внешнего слоя */
export async function makeHistoryEvent(input: HistoryEventInput): Promise<Record<string, unknown>> {
  const encrypted = await encryptInnerEvent({
    innerEvent: input.inner,
    groupChatId: input.groupChatId,
    syncId: input.syncId,
    senderKeyId: input.senderKeyId,
    senderPrivateKey: input.senderPrivateKey,
    recipient: input.recipient,
  });

  const readers = Array.from({ length: input.readByCount ?? 0 }, (_, index) => ({
    user_huid: `reader-huid-${index}`,
  }));

  return {
    ...encrypted.event,
    event_type: 'message_new',
    inserted_at: input.insertedAt,
    sender: input.sender,
    read_by: readers,
    ...(input.reactionCounters !== undefined
      ? {
          meta: {
            activities: {
              reaction_counters: input.reactionCounters,
              user_reactions: { emoji: input.myReactions ?? [], votes: [] },
            },
          },
        }
      : {}),
  };
}
