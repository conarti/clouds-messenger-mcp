/**
 * Форма чата: сырая запись списка чатов -> внутренняя запись -> публичная выдача.
 *
 * ГЛАВНОЕ ПРАВИЛО, ради которого форма разведена на две. `chat_id` это `group_chat_id`
 * сервера и НИЧЕГО больше: он не собирается из huid участников, не сортируется, не
 * склеивается через разделитель. У Яндекса приватный чат адресовался парой guid, и там
 * конструирование было единственным способом; здесь сервер выдаёт единый UUID на любой
 * чат, включая чат с собой, поэтому любая склейка была бы выдумкой адреса.
 *
 * Внутренняя запись несёт `key_ids` (это `chat.keys`, получатели обёртки контент-ключа),
 * а публичная не несёт: снаружи ключевой материал не нужен ни для чего, а его присутствие
 * в выдаче инструмента означало бы ключи сессии в контексте модели. Точно так же наружу
 * не уходит `member_huids`: список людей чата нужен внутри и только внутри.
 *
 * ИМЯ ЛИЧНОГО ЧАТА ПРИЕЗЖАЕТ НЕ С ЧАТОМ. Сервер называет все личные чаты одинаково, а имя
 * собеседника лежит в справке о профилях, поэтому имена подставляет отдельный шаг
 * (`resolvePeerNames`), а не нормализация: нормализация обязана оставаться разбором формы
 * без единого обращения к сети.
 */
import type { AuthProvider } from '../auth/AuthProvider.js';
import { asObject, numberOr, stringOr } from '../util/json.js';
import { parseIso } from '../util/timestamps.js';
import { fetchProfilesByHuids, type ProfilesDeps } from './profiles.js';

/** Значение `chat_type` чата с собой: единственный признак, по которому он отличается */
export const SELF_CHAT_TYPE = 'notes';

/** `chat_type` личного чата: собеседник ровно один, и имя чата это его имя */
export const PERSONAL_CHAT_TYPE = 'chat';

/** Внутренняя запись чата: всё, что нужно слоям протокола и адресации */
export interface ChatRecord {
  /** `group_chat_id` как есть: единый UUID чата любого вида */
  chat_id: string;
  name?: string;
  /** `chat_type` строкой как есть: закрывать союз до живой переписи значений нечем */
  kind: string;
  members_count?: number;
  /** `updated_at` в ISO: по нему список сортируется свежими вперёд */
  last_activity?: string;
  /** `message_pinned_sync_id`: адрес закреплённого сообщения */
  pinned_message_id?: string;
  /** `chat.keys`: получатели обёртки контент-ключа, нужны отправке и наружу не уходят */
  key_ids: string[];
  /**
   * `member_huids`: участники чата. Наружу НЕ уходят: список идентификаторов людей это
   * персональные данные без единого потребителя снаружи. Внутри они нужны ровно за одним,
   * найти собеседника личного чата, чтобы спросить справку о его имени.
   */
  member_huids: string[];
  is_self: boolean;
  /** huid собеседника личного чата: проставляется резолвом имён, а не нормализацией */
  peer_huid?: string;
  /** Профиль собеседника, если справка его назвала */
  peer?: ChatPeer;
}

/** Собеседник личного чата в публичной выдаче: имя и рабочий контекст, без контактов */
export interface ChatPeer {
  name: string;
  company_position?: string;
  department?: string;
}

/** Публичная форма чата: то, что видит модель */
export interface Chat {
  chat_id: string;
  name?: string;
  kind: string;
  members_count?: number;
  last_activity?: string;
  unread_count: number;
  unread: boolean;
  pinned_message_id?: string;
  /** Есть только у личного чата: адрес человека, которым он адресуется в справке */
  peer_huid?: string;
  peer?: ChatPeer;
}

/** Приводит к ISO, а непонятную строку считает отсутствующей: гадать про формат нечем */
function isoOrAbsent(value: unknown): string | undefined {
  const raw = stringOr(value);
  if (raw === undefined) {
    return undefined;
  }
  try {
    return parseIso(raw).toISOString();
  } catch {
    return undefined;
  }
}

/** Массив непустых строк: и ключи получателей, и участники приезжают именно так */
function stringsOf(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    const item = stringOr(entry);
    return item === undefined ? [] : [item];
  });
}

/**
 * Сырая запись чата во внутреннюю. Запись без `group_chat_id` не нормализуется: чат,
 * который нечем адресовать, наружу отдавать нельзя, а подставлять ему выдуманный адрес
 * тем более.
 */
export function normalizeChat(raw: unknown): ChatRecord | undefined {
  const chat = asObject(raw);
  if (chat === undefined) {
    return undefined;
  }
  const chatId = stringOr(chat['group_chat_id']);
  if (chatId === undefined) {
    return undefined;
  }
  const name = stringOr(chat['name']);
  const kind = stringOr(chat['chat_type']) ?? 'unknown';
  const membersCount = numberOr(chat['members_count']);
  const lastActivity = isoOrAbsent(chat['updated_at']);
  const pinnedMessageId = stringOr(chat['message_pinned_sync_id']);

  return {
    chat_id: chatId,
    ...(name !== undefined ? { name } : {}),
    kind,
    ...(membersCount !== undefined ? { members_count: membersCount } : {}),
    ...(lastActivity !== undefined ? { last_activity: lastActivity } : {}),
    ...(pinnedMessageId !== undefined ? { pinned_message_id: pinnedMessageId } : {}),
    key_ids: stringsOf(chat['keys']),
    member_huids: stringsOf(chat['member_huids']),
    is_self: kind === SELF_CHAT_TYPE,
  };
}

/** Весь список разом; неадресуемые записи выпадают, остальные не страдают */
export function normalizeChats(raw: unknown): ChatRecord[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((entry) => {
    const record = normalizeChat(entry);
    return record === undefined ? [] : [record];
  });
}

/**
 * Публичная форма. `unread_count` и `unread` идут парой намеренно: булев флаг это то, по
 * чему фильтрует вызывающий, а число это то, что он показывает, и вычислять одно из
 * другого на своей стороне ему не нужно.
 */
export function toPublicChat(record: ChatRecord, unreadCount: number): Chat {
  return {
    chat_id: record.chat_id,
    ...(record.name !== undefined ? { name: record.name } : {}),
    kind: record.kind,
    ...(record.members_count !== undefined ? { members_count: record.members_count } : {}),
    ...(record.last_activity !== undefined ? { last_activity: record.last_activity } : {}),
    unread_count: unreadCount,
    unread: unreadCount > 0,
    ...(record.pinned_message_id !== undefined ? { pinned_message_id: record.pinned_message_id } : {}),
    ...(record.peer_huid !== undefined ? { peer_huid: record.peer_huid } : {}),
    ...(record.peer !== undefined ? { peer: record.peer } : {}),
  };
}

/** Зависимости резолва имён: справка о профилях плюс собственная идентичность */
export type PeerNamesDeps = ProfilesDeps & { auth: AuthProvider };

/** Собеседник это участник, не равный мне; в чате не на двоих собеседника нет */
function peerHuidOf(record: ChatRecord, myHuid: string): string | undefined {
  if (record.kind !== PERSONAL_CHAT_TYPE) {
    return undefined;
  }
  const others = record.member_huids.filter((huid) => huid !== myHuid);
  return others.length === 1 ? others[0] : undefined;
}

/**
 * Подставляет в личные чаты имена собеседников.
 *
 * Работает СПИСКОМ, а не по одному чату: справка принимает батч, и один вызов на весь
 * список это разница между одним обращением и полусотней. Кэш профилей делает повторный
 * вызов бесплатным, поэтому резолв не приходится экономить в вызывающем.
 *
 * Профиль, которого справка не назвала, НЕ придумывается: у чата остаётся серверное
 * «personal chat», а рядом появляется `peer_huid`, по которому человека можно опознать
 * хотя бы адресом. Подставить сюда huid вместо имени значило бы выдать идентификатор за
 * имя человека.
 */
export async function resolvePeerNames(
  deps: PeerNamesDeps,
  records: readonly ChatRecord[],
): Promise<ChatRecord[]> {
  if (!records.some((record) => record.kind === PERSONAL_CHAT_TYPE)) {
    return [...records];
  }

  const { huid: myHuid } = await deps.auth.getWhoami();
  const peers = new Map<string, string>();
  for (const record of records) {
    const peerHuid = peerHuidOf(record, myHuid);
    if (peerHuid !== undefined) {
      peers.set(record.chat_id, peerHuid);
    }
  }

  const profiles = await fetchProfilesByHuids(deps, [...peers.values()]);

  return records.map((record) => {
    const peerHuid = peers.get(record.chat_id);
    if (peerHuid === undefined) {
      return record;
    }
    const profile = profiles.get(peerHuid);
    if (profile === undefined) {
      return { ...record, peer_huid: peerHuid };
    }
    return {
      ...record,
      name: profile.name,
      peer_huid: peerHuid,
      peer: {
        name: profile.name,
        ...(profile.company_position !== undefined
          ? { company_position: profile.company_position }
          : {}),
        ...(profile.department !== undefined ? { department: profile.department } : {}),
      },
    };
  });
}

/**
 * Свежие первыми. Чат без `updated_at` уезжает в хвост, а не в голову: неизвестная свежесть
 * не значит «свежайший», и попадание такого чата в срез вытеснило бы заведомо живой.
 */
export function sortChatsByFreshness(records: readonly ChatRecord[]): ChatRecord[] {
  return [...records].sort((left, right) => {
    if (left.last_activity === right.last_activity) {
      return 0;
    }
    if (left.last_activity === undefined) {
      return 1;
    }
    if (right.last_activity === undefined) {
      return -1;
    }
    return left.last_activity < right.last_activity ? 1 : -1;
  });
}
