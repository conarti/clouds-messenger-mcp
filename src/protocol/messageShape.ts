/**
 * Единая форма сообщения: одна на все инструменты чтения.
 *
 * АДРЕС СООБЩЕНИЯ ЭТО `sync_id`, И ЭТО UUID. Не число, не метка времени, не `msg_id`
 * внутреннего события. `sync_id` живёт во внешнем событии, им же адресуется курсор
 * истории и точечное чтение, поэтому именно он уходит наружу как `message_id`. Метка
 * времени в Клаудс арифметическим курсором не является, и любая правка адреса на единицу,
 * уместная на микросекундных метках Яндекса, здесь была бы порчей UUID.
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
  /* Текст живёт в `body` и только у текстового события: у файловых там `payload` */
  const text = innerType === 'text' ? stringOr(inner?.['body']) : undefined;
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
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(reactions.length > 0 ? { reactions } : {}),
    ...(readByCount !== undefined ? { read_by_count: readByCount } : {}),
    ...(decrypted?.error !== undefined ? { decrypt_error: decrypted.error } : {}),
  };
}
