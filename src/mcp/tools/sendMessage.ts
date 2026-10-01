/**
 * `send_message`: единственная необратимая операция набора. Один вызов отправляет сообщение.
 *
 * ПОДТВЕРЖДЕНИЕ СОБИРАЕТ ВЫЗЫВАЮЩИЙ ДО ВЫЗОВА. Второй шаг на стороне сервера ничего не
 * защищал: агент, получивший согласие человека, всё равно подтверждал второй шаг сам. Сервер
 * отвечает за строгий резолв адресата и за честный отказ.
 *
 * НЕОДНОЗНАЧНОСТЬ НЕ РАЗРЕШАЕТСЯ ГАДАНИЕМ. Несколько кандидатов означает выдачу кандидатов
 * наружу, и ни один кадр при этом не уходит: выбор делает вызывающий. Цена ошибки здесь это
 * сообщение не тому человеку.
 *
 * ПОВТОР ВЫЗОВА СОЗДАЁТ ВТОРОЕ СООБЩЕНИЕ. Идентификатор отправки генерируется на каждый
 * вызов, а серверный дедуп по повторному `sync_id` не подтверждён.
 *
 * Ошибкой MCP наружу уходит только отказ сервера, потому что чинить его вызывающему нечем.
 */
import { resolveChat } from '../../chat/resolveChat.js';
import { resolveFailure, type ChatResolveFailure } from '../../chat/resolveFailure.js';
import { buildMessageNewRequest, sendMessageNew } from '../../protocol/mutations.js';
import { createRequestId } from '../../transport/requestId.js';
import type { ToolDeps } from './deps.js';

export interface SendMessageInput {
  chat: string;
  text: string;
}

/** Потолок длины текста; тем же числом ограничена схема параметра */
export const TEXT_MAX_LENGTH = 10_000;

export interface SendMessageSent {
  status: 'sent';
  chat_id: string;
  /** Имя чата, если оно у чата есть: по одному UUID человек не узнает адресата */
  chat_name?: string;
  /** Идентификатор отправки: он же адрес сообщения в истории */
  message_id: string;
  /** Метка сервера; отсутствует, если сервер её не прислал */
  inserted_at?: string;
}

export type SendMessageResult = SendMessageSent | ChatResolveFailure;

export async function sendMessage(
  deps: ToolDeps,
  input: SendMessageInput,
): Promise<SendMessageResult> {
  const resolved = await resolveChat(deps, input.chat);
  if (resolved.kind !== 'resolved') {
    return resolveFailure(resolved);
  }
  const chat = resolved.chat;
  const syncId = createRequestId();

  deps.logger.info('send_message: отправка', {
    chatId: chat.chat_id,
    syncId,
    textLength: input.text.length,
  });
  const request = await buildMessageNewRequest({
    chat,
    text: input.text,
    syncId,
    deps,
  });
  const ack = await sendMessageNew(deps, request);

  return {
    status: 'sent',
    chat_id: chat.chat_id,
    ...(chat.name !== undefined ? { chat_name: chat.name } : {}),
    message_id: syncId,
    ...(ack.inserted_at !== undefined ? { inserted_at: ack.inserted_at } : {}),
  };
}
