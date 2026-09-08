/**
 * Список чатов и счётчики непрочитанного.
 *
 * Полный базовый список берётся одним вызовом с `since` в начале эпохи: событие отдаёт
 * ИЗМЕНЕНИЯ с указанного момента, поэтому «с начала времён» это и есть «всё» (наблюдено
 * живьём, findings.md, секция протокольных констант). Инкрементальной подкачки тут нет
 * намеренно: сервер MCP не держит состояния между вызовами, и хранить свой `since` было бы
 * состоянием, которое некому потреблять.
 *
 * Непрочитанное приезжает ОТДЕЛЬНЫМ событием, а не полем чата: в отличие от Яндекса, где
 * счётчики выводились из меток того же ответа, здесь их приходится спрашивать явно списком
 * идентификаторов чатов.
 */
import type { Config } from '../config/types.js';
import type { PhoenixClient } from '../transport/ws/types.js';
import type { Logger } from '../util/logger.js';
import { asObject, numberOr, stringOr } from '../util/json.js';

/** Топик служебных событий: список чатов, счётчики, треды, адресное чтение события */
export const SYSTEM_TOPIC = 'system';

export const CHAT_LIST_EVENT = 'get_chat_list_base_changes';
export const UNREAD_COUNTERS_EVENT = 'get_unread_counters';

/**
 * Начало эпохи в том виде, в каком его принимает сервер: микросекундная точность и `Z`.
 * Формат повторён с живого запроса веб-клиента, а не выведен из `Date.toISOString()`,
 * который отдаёт миллисекунды.
 */
export const CHAT_LIST_SINCE_EPOCH = '1970-01-01T00:00:00.000000Z';

export interface ChatListDeps {
  ws: PhoenixClient;
  config: Config;
  logger: Logger;
}

/** Сырые записи чатов: нормализацию делает `chatShape`, здесь только доставка */
export async function fetchChatList(deps: ChatListDeps): Promise<unknown[]> {
  const response = await deps.ws.request<unknown>(SYSTEM_TOPIC, CHAT_LIST_EVENT, {
    since: CHAT_LIST_SINCE_EPOCH,
    request_version: deps.config.protocol.chatListRequestVersion,
  });
  const chats = asObject(response)?.[CHAT_LIST_EVENT];
  const list = Array.isArray(chats) ? chats : [];
  deps.logger.debug('список чатов получен', { count: list.length });
  return list;
}

/**
 * Счётчики непрочитанного по списку чатов.
 *
 * Пустой список не превращается в вызов: сервер на пустом `group_chats` ответит пустотой,
 * а лишний кадр в сокете это лишний повод для таймаута на пустой учётной записи.
 */
export async function fetchUnreadCounters(
  deps: ChatListDeps,
  chatIds: readonly string[],
): Promise<Map<string, number>> {
  const counters = new Map<string, number>();
  if (chatIds.length === 0) {
    return counters;
  }

  const response = await deps.ws.request<unknown>(SYSTEM_TOPIC, UNREAD_COUNTERS_EVENT, {
    group_chats: [...chatIds],
  });
  const raw = asObject(response)?.['unread_counters'];
  if (!Array.isArray(raw)) {
    return counters;
  }

  for (const entry of raw) {
    const record = asObject(entry);
    const chatId = stringOr(record?.['group_chat_id']);
    const counter = numberOr(record?.['counter']);
    if (chatId !== undefined && counter !== undefined) {
      counters.set(chatId, counter);
    }
  }
  deps.logger.debug('счётчики непрочитанного получены', { requested: chatIds.length, received: counters.size });
  return counters;
}
