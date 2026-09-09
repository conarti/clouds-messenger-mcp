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

/**
 * Собеседники личных чатов. Имена синтетические намеренно: фикстуры уезжают в репозиторий,
 * и живое имя коллеги в них означало бы персональные данные в открытом коде.
 */
export const PEER_HUID = '44444444-4444-5444-8444-444444444444';
export const SECOND_PEER_HUID = '55555555-5555-5555-8555-555555555555';
/** Собеседник, которого справка не назвала: у такого чата имя остаётся серверным */
export const NAMELESS_PEER_HUID = '66666666-6666-5666-8666-666666666666';

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
  /** Участники чата: у личного чата это я и собеседник */
  memberHuids?: string[];
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
    member_huids: input.memberHuids ?? [MY_HUID],
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

/** Упоминание внутри события: форма снята живой пробой */
export interface MentionFixture {
  mentionId: string;
  name: string;
  /** Адресат упоминания; у упоминания всего чата его нет */
  huid?: string;
  mentionType?: string;
}

function makeMentions(mentions: readonly MentionFixture[]): Record<string, unknown>[] {
  return mentions.map((mention) => ({
    mention_type: mention.mentionType ?? 'contact',
    mention_id: mention.mentionId,
    mention_data: {
      conn_type: 'cts',
      ...(mention.huid !== undefined ? { user_huid: mention.huid } : {}),
      name: mention.name,
    },
  }));
}

export function makeInnerText(input: {
  msgId: string;
  from: string;
  timestamp: string;
  groupChatId: string;
  body: string;
  mentions?: readonly MentionFixture[];
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
    ...(input.mentions !== undefined ? { mentions: makeMentions(input.mentions) } : {}),
  };
}

/**
 * Событие со ссылкой: поля как у текстового плюс `link_file_id` и `payload.url` (форма
 * снята живой пробой). Текст сообщения лежит в том же `body`, что и у текстового.
 */
export function makeInnerLink(input: {
  msgId: string;
  from: string;
  timestamp: string;
  groupChatId: string;
  body: string;
  url: string;
  mentions?: readonly MentionFixture[];
}): Record<string, unknown> {
  return {
    ...makeInnerText(input),
    type: 'link',
    link_file_id: 'c0ffee00-0000-4000-8000-00000000000a',
    payload: { url: input.url },
  };
}

/** Профиль в ответе справки: набор полей повторяет живой ответ */
export interface ProfileFixture {
  huid: string;
  name: string;
  company?: string;
  companyPosition?: string;
  department?: string;
  email?: string;
}

/**
 * Ответ справки о профилях по huid: конверт со списком серверных групп, в каждой свой
 * `cts_profiles`. Группы разнесены отдельным аргументом намеренно: живая проба вернула
 * одну, а разбор обязан собирать профили со всех.
 */
export function makeProfilesResponse(groups: readonly (readonly ProfileFixture[])[]): unknown {
  return {
    status: 'ok',
    result: groups.map((profiles, index) => ({
      server_name: `cts0${index + 1}.example.test`,
      server_id: `server-${index + 1}`,
      access_level: 'full',
      generated_at: '2026-09-09T07:00:00.000000Z',
      cts_profiles: profiles.map((profile) => ({
        user_huid: profile.huid,
        name: profile.name,
        active: true,
        kind: 'user',
        email: profile.email ?? null,
        company: profile.company ?? null,
        company_position: profile.companyPosition ?? null,
        department: profile.department ?? null,
        office: null,
        manager: null,
        manager_huid: null,
        phone: null,
        avatar: null,
        avatar_preview: null,
        description: null,
        updated_at: '2026-09-01T07:00:00.000000Z',
      })),
    })),
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
