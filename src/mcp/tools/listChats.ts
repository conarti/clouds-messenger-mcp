/**
 * `list_chats`: точка входа. Единственный инструмент, которому не нужно знать заранее
 * ни одного идентификатора.
 *
 * ЦЕНА ВЫЗОВА. Базовый вызов стоит ДВА кадра: список чатов и счётчики непрочитанного.
 * Счётчики приезжают отдельным событием, а не полем чата, поэтому свести их к одному
 * кадру нельзя. Плюс ОДИН запрос справки о профилях, если в списке есть личные чаты: без
 * него все они называются одинаковой серверной заглушкой. Справка спрашивается батчем на
 * весь список и кэшируется, поэтому следующие вызовы её не повторяют. Опт-ин на текст
 * последнего сообщения стоит ЕЩЁ ПО ОДНОМУ кадру на каждый чат страницы, и это названо
 * прямо в описании инструмента: цена, спрятанная от модели, платится всё равно, только
 * неожиданно.
 *
 * ПРИВАТНОСТЬ ПО УМОЛЧАНИЮ. Текст последних сообщений не отдаётся: один вызов иначе тащил
 * бы в контекст модели содержимое всех переписок сразу.
 */
import { fetchChatList, fetchUnreadCounters } from '../../protocol/chatList.js';
import {
  normalizeChats,
  resolvePeerNames,
  sortChatsByFreshness,
  toPublicChat,
  type Chat,
  type ChatRecord,
} from '../../protocol/chatShape.js';
import { decryptHistoryEvents, toMessages } from '../../protocol/decryptHistory.js';
import { enrichMessages, type EnrichedMessage } from '../../protocol/enrichMessage.js';
import { fetchHistoryPage } from '../../protocol/history.js';
import type { ToolDeps } from './deps.js';

/** `| undefined` в полях осознанно: под exactOptionalPropertyTypes zod отдаёт именно такой тип */
export interface ListChatsInput {
  limit?: number | undefined;
  unread_only?: boolean | undefined;
  include_last_message_text?: boolean | undefined;
}

export interface ListedChat extends Chat {
  /** Последнее сообщение чата: только по опт-ину `include_last_message_text` */
  last_message?: EnrichedMessage;
}

export interface ListChatsResult {
  status: 'ok';
  chats: ListedChat[];
  /** Сколько чатов отдал сервер ДО фильтрации и среза: сравнение с длиной покажет срез */
  total_chats: number;
  unread_chats: number;
}

/** Последнее сообщение одного чата: отдельный кадр истории с лимитом в одно событие */
async function fetchLastMessage(
  deps: ToolDeps,
  chat: ChatRecord,
): Promise<EnrichedMessage | undefined> {
  const page = await fetchHistoryPage(deps, { chatId: chat.chat_id, limit: 1 });
  const messages = enrichMessages(toMessages(await decryptHistoryEvents(deps, page.events)), chat);
  return messages.at(-1);
}

export async function listChats(deps: ToolDeps, input: ListChatsInput = {}): Promise<ListChatsResult> {
  const limit = input.limit ?? deps.config.limits.listChatsDefaultLimit;

  /*
   * Имена собеседников подставляются ДО фильтрации и среза. Иначе `unread_only` и `limit`
   * работали бы по серверной заглушке имени, одинаковой у всех личных чатов, и страница
   * получалась бы правильной по числу и бессмысленной по содержанию.
   */
  const records = await resolvePeerNames(
    deps,
    sortChatsByFreshness(normalizeChats(await fetchChatList(deps))),
  );
  const counters = await fetchUnreadCounters(
    deps,
    records.map((record) => record.chat_id),
  );

  const all = records.map((record) => ({
    record,
    chat: toPublicChat(record, counters.get(record.chat_id) ?? 0),
  }));
  const unreadChats = all.filter((entry) => entry.chat.unread).length;
  const selected = (input.unread_only === true ? all.filter((entry) => entry.chat.unread) : all).slice(
    0,
    limit,
  );

  const chats: ListedChat[] = [];
  for (const entry of selected) {
    if (input.include_last_message_text !== true) {
      chats.push(entry.chat);
      continue;
    }
    /*
     * Последовательно, а не параллельно: кадры уходят в один сокет, и залп на пятьдесят
     * чатов сразу упёрся бы в лимиты сервера, а не ускорил бы выдачу.
     */
    const lastMessage = await fetchLastMessage(deps, entry.record);
    chats.push({ ...entry.chat, ...(lastMessage !== undefined ? { last_message: lastMessage } : {}) });
  }

  deps.logger.debug('list_chats: список собран', {
    total: all.length,
    unread: unreadChats,
    returned: chats.length,
    withLastMessage: input.include_last_message_text === true,
  });

  return { status: 'ok', chats, total_chats: all.length, unread_chats: unreadChats };
}
