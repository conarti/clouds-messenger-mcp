/**
 * `get_message`: одно сообщение по адресу, без загрузки истории вокруг него.
 *
 * ФОРМА ПОДТВЕРЖДЕНА ЖИВЬЁМ. Адресное чтение прошло живой пробой на полигоне: сервер
 * принимает событие и отвечает конвертом с полем `info`, из которого сообщение читается и
 * расшифровывается. Метки неподтверждённости в выдаче поэтому нет.
 *
 * ОТСУТСТВИЕ СООБЩЕНИЯ НЕ ОШИБКА. Ненайденное сообщение это предметный отказ со статусом,
 * по которому вызывающий ветвится сам, а не MCP-ошибка: сообщение могло быть удалено, и
 * это штатный факт переписки.
 */
import { containerChatOf, resolveChat } from '../../chat/resolveChat.js';
import { resolveFailure, type ChatResolveFailure } from '../../chat/resolveFailure.js';
import { decryptHistoryEvents, toMessages } from '../../protocol/decryptHistory.js';
import { enrichMessage, type EnrichedMessage } from '../../protocol/enrichMessage.js';
import { fetchEventBySyncId } from '../../protocol/eventInfo.js';
import { attachReplyCounts } from '../../protocol/threads.js';
import {
  messageIdMissing,
  messageIdOf,
  messageNotFound,
  messageOutsideChat,
  type MessageInputInvalid,
  type MessageNotFound,
} from './messageFailure.js';
import type { ToolDeps } from './deps.js';

export interface GetMessageInput {
  /** Чат, тред либо ссылка xlnk на сообщение */
  chat: string;
  /** Без него адрес берётся из `sync_id` ссылки в `chat` */
  message_id?: string | undefined;
}

export interface GetMessageOk {
  status: 'ok';
  chat_id: string;
  message: EnrichedMessage;
}

export type GetMessageResult =
  | GetMessageOk
  | MessageNotFound
  | MessageInputInvalid
  | ChatResolveFailure;

export async function getMessage(deps: ToolDeps, input: GetMessageInput): Promise<GetMessageResult> {
  const messageId = messageIdOf(input);
  if (messageId === undefined) {
    return messageIdMissing();
  }
  const resolved = await resolveChat(deps, input.chat);
  if (resolved.kind !== 'resolved') {
    return resolveFailure(resolved);
  }

  const lookup = await fetchEventBySyncId(deps, { chatId: resolved.chat.chat_id, syncId: messageId });
  const found = lookup.event;
  if (found === undefined) {
    return messageNotFound(`в чате ${resolved.chat.chat_id} нет события с sync_id ${messageId}`);
  }
  /* Сообщение треда, адресованное родительским чатом, отдаётся с адресом и контекстом треда */
  const chat = await containerChatOf(deps, resolved.chat, found);
  if (chat === undefined) {
    return messageOutsideChat(messageId, resolved.chat.chat_id);
  }

  const [message] = toMessages(await decryptHistoryEvents(deps, [found]));
  if (message === undefined) {
    return messageNotFound(`событие ${messageId} пришло без адреса и наружу отдано быть не может`);
  }

  const enriched = enrichMessage(message, chat);
  const [counted] = await attachReplyCounts(deps, [enriched]);
  return { status: 'ok', chat_id: chat.chat_id, message: counted ?? enriched };
}
