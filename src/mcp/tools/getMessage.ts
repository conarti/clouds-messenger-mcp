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
import { resolveChat } from '../../chat/resolveChat.js';
import { resolveFailure, type ChatResolveFailure } from '../../chat/resolveFailure.js';
import { decryptHistoryEvents, toMessages } from '../../protocol/decryptHistory.js';
import { enrichMessage, type EnrichedMessage } from '../../protocol/enrichMessage.js';
import { fetchEventBySyncId } from '../../protocol/eventInfo.js';
import { messageNotFound, type MessageNotFound } from './messageFailure.js';
import type { ToolDeps } from './deps.js';

export interface GetMessageInput {
  chat: string;
  message_id: string;
}

export interface GetMessageOk {
  status: 'ok';
  chat_id: string;
  message: EnrichedMessage;
}

export type GetMessageResult = GetMessageOk | MessageNotFound | ChatResolveFailure;

export async function getMessage(deps: ToolDeps, input: GetMessageInput): Promise<GetMessageResult> {
  const resolved = await resolveChat(deps, input.chat);
  if (resolved.kind !== 'resolved') {
    return resolveFailure(resolved);
  }
  const chat = resolved.chat;

  const lookup = await fetchEventBySyncId(deps, { chatId: chat.chat_id, syncId: input.message_id });
  const found = lookup.event;
  if (found === undefined) {
    return messageNotFound(`в чате ${chat.chat_id} нет события с sync_id ${input.message_id}`);
  }

  const [message] = toMessages(await decryptHistoryEvents(deps, [found]));
  if (message === undefined) {
    return messageNotFound(`событие ${input.message_id} пришло без адреса и наружу отдано быть не может`);
  }

  return { status: 'ok', chat_id: chat.chat_id, message: enrichMessage(message, chat) };
}
