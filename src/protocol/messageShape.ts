/**
 * Единая форма сообщения: одна на все инструменты чтения.
 *
 * АДРЕС СООБЩЕНИЯ ЭТО `sync_id`, И ЭТО UUID. Не число, не метка времени, не `msg_id`
 * внутреннего события. `sync_id` живёт во внешнем событии, им же адресуется курсор
 * истории и точечное чтение, поэтому именно он уходит наружу как `message_id`. Метка
 * времени в Клаудс арифметическим курсором не является, и любая правка адреса на единицу,
 * уместная на микросекундных метках Яндекса, здесь была бы порчей UUID.
 *
 * ТЕКСТ БЕРЁТСЯ ИЗ `body`, А НЕ ИЗ ТИПА СОБЫТИЯ. Сообщение со ссылкой это отдельный
 * внутренний тип с теми же полями, что у текстового, и текст у него лежит там же. Отбор по
 * типу оставлял такие сообщения вообще без текста, поэтому решает наличие поля, а не имя типа.
 *
 * СОБЫТИЕ НЕ ИСЧЕЗАЕТ ИЗ-ЗА НЕРАСШИФРОВКИ. Нечитаемое тело даёт `decrypt_error`, а не
 * пропуск: дыра в переписке читается вызывающим как факт, которого не было.
 */
import { asObject, stringOr } from '../util/json.js';
import { parseIso } from '../util/timestamps.js';
import { extractAttachments, type Attachment } from './attachments.js';
import { extractReactions, type Reaction } from './reactions.js';

/**
 * Идентификаторы этого протокола это UUID: и адрес чата (`group_chat_id`), и адрес
 * сообщения (`sync_id`). Один образец на оба, потому что различать их формой нечем, а две
 * копии одного выражения разъедутся при первой же правке.
 */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ссылка сообщения: только адрес; предпросмотр ссылки сервер отдаёт отдельным файлом */
export interface MessageLink {
  url: string;
}

/** Упомянутый человек: адрес и имя, которым его назвал отправитель */
export interface Mention {
  huid: string;
  name: string;
}

/** `type` внутреннего события со ссылкой: текст в `body`, адрес в `payload.url` */
const LINK_EVENT_TYPE = 'link';

/**
 * Плейсхолдер упоминания в тексте: `@{mention:<идентификатор>}`. Идентификатор ищется в
 * `mentions` того же события, поэтому образец захватывает его целиком до закрывающей скобки.
 */
const MENTION_PLACEHOLDER = /@\{mention:([^}]+)\}/g;

export interface Message {
  /** `sync_id` внешнего события: UUID, им же адресуются курсор и точечное чтение */
  message_id: string;
  chat_id: string;
  from?: string;
  /**
   * ISO-метка. Отсутствует, если её нет ни во внутреннем событии, ни во внешнем: выдуманное
   * время хуже отсутствующего, потому что по нему отфильтруют и отсортируют.
   */
  timestamp?: string;
  /** Тип ВНЕШНЕГО события (`message_new` и родня) */
  event_type: string;
  /** Тип ВНУТРЕННЕГО события (`text`, `image`, `file`): есть только у расшифрованного */
  type?: string;
  text?: string;
  /** Ссылка события типа `link`: сам адрес, текст сообщения при этом лежит в `text` */
  link?: MessageLink;
  /** Упомянутые люди: есть, только если событие несёт упоминания */
  mentions?: Mention[];
  attachments?: Attachment[];
  reactions?: Reaction[];
  read_by_count?: number;
  /** Текст отказа расшифровки с тегом слоя; сообщение при этом остаётся в выдаче */
  decrypt_error?: string;
}

/** Разобранное внутреннее событие вместе с отказом, если расшифровка не удалась */
export interface DecryptedPart {
  inner?: Record<string, unknown>;
  error?: string;
}

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

/** Разобранные упоминания: имена для подстановки в текст и сами адресаты для выдачи */
interface ParsedMentions {
  names: Map<string, string>;
  people: Mention[];
}

/**
 * Упоминания внутреннего события.
 *
 * Имя и адрес берутся из `mention_data`, а ключом подстановки служит `mention_id`: именно
 * он стоит в тексте. Упоминание без адреса (например, упоминание всего чата) в список
 * адресатов не попадает, но именем в тексте подставляется: текст обязан читаться целиком.
 */
function parseMentions(inner: Record<string, unknown> | undefined): ParsedMentions {
  const names = new Map<string, string>();
  const people: Mention[] = [];
  const raw = inner?.['mentions'];
  if (!Array.isArray(raw)) {
    return { names, people };
  }
  for (const entry of raw) {
    const mention = asObject(entry);
    const data = asObject(mention?.['mention_data']);
    const name = stringOr(data?.['name']);
    if (name === undefined) {
      continue;
    }
    const mentionId = stringOr(mention?.['mention_id']);
    if (mentionId !== undefined) {
      names.set(mentionId, name);
    }
    const huid = stringOr(data?.['user_huid']);
    if (huid !== undefined) {
      people.push({ huid, name });
    }
  }
  return { names, people };
}

/**
 * Подставляет имена в плейсхолдеры упоминаний.
 *
 * Незнакомый идентификатор остаётся плейсхолдером КАК ЕСТЬ: имени у него нет, а подставить
 * туда что-нибудь значило бы придумать адресата, которого в событии не было.
 */
function applyMentions(text: string, names: ReadonlyMap<string, string>): string {
  return text.replace(MENTION_PLACEHOLDER, (placeholder, mentionId: string) => {
    const name = names.get(mentionId);
    return name === undefined ? placeholder : `@${name}`;
  });
}

/** Адрес ссылки: он лежит в `payload.url`, а текст сообщения в `body` рядом */
function linkOf(inner: Record<string, unknown> | undefined): MessageLink | undefined {
  const url = stringOr(asObject(inner?.['payload'])?.['url']);
  return url === undefined ? undefined : { url };
}

/**
 * Внешнее событие плюс расшифрованное внутреннее в единую форму.
 *
 * `undefined` означает событие без `sync_id` либо без `group_chat_id`: адресовать его
 * нечем, а выдавать сообщение с выдуманным адресом наружу нельзя, потому что по этому
 * адресу вызывающий пойдёт читать контекст и получит чужое.
 */
export function normalizeEvent(rawEvent: unknown, decrypted?: DecryptedPart): Message | undefined {
  const event = asObject(rawEvent);
  const messageId = stringOr(event?.['sync_id']);
  const chatId = stringOr(event?.['group_chat_id']);
  if (event === undefined || messageId === undefined || chatId === undefined) {
    return undefined;
  }

  const inner = decrypted?.inner;
  const from = stringOr(inner?.['from']) ?? stringOr(event['sender']);
  const timestamp = isoOrAbsent(inner?.['timestamp']) ?? isoOrAbsent(event['inserted_at']);
  const innerType = stringOr(inner?.['type']);
  /*
   * Текст живёт в `body` у ЛЮБОГО события, которое его несёт: живьём это `text` и `link`,
   * а у файловых событий поля `body` просто нет, и сверять тип отдельно незачем. Сверка по
   * типу как раз и стоила сообщениям со ссылкой их текста: тип был не тот, текст был на месте.
   */
  const mentions = parseMentions(inner);
  const rawText = stringOr(inner?.['body']);
  const text = rawText === undefined ? undefined : applyMentions(rawText, mentions.names);
  const link = innerType === LINK_EVENT_TYPE ? linkOf(inner) : undefined;
  /* Вложения и реакции разбираются своими модулями: их же читают инструменты напрямую */
  const attachments = extractAttachments(inner);
  const reactions = extractReactions(event);
  const readBy = event['read_by'];
  const readByCount = Array.isArray(readBy) ? readBy.length : undefined;

  return {
    message_id: messageId,
    chat_id: chatId,
    ...(from !== undefined ? { from } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
    event_type: stringOr(event['event_type']) ?? 'unknown',
    ...(innerType !== undefined ? { type: innerType } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(link !== undefined ? { link } : {}),
    ...(mentions.people.length > 0 ? { mentions: mentions.people } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(reactions.length > 0 ? { reactions } : {}),
    ...(readByCount !== undefined ? { read_by_count: readByCount } : {}),
    ...(decrypted?.error !== undefined ? { decrypt_error: decrypted.error } : {}),
  };
}
