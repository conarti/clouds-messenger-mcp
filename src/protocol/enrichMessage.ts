/**
 * Обогащение сообщения контекстом чата.
 *
 * ОБОГАЩЕНИЕ АДДИТИВНО. Оно только ДОБАВЛЯЕТ ключи, база не меняется и не переписывается.
 * Благодаря этому один и тот же слой навешивается на выдачу истории, точечного чтения и
 * окна контекста, и ни один канал не теряет полей только потому, что сообщение приехало
 * другим путём.
 *
 * Контекст чата попадает в сообщение, а не остаётся только в шапке ответа, потому что
 * сообщения из выдачи живут дальше по отдельности: вызывающий кладёт их в список, и без
 * имени чата рядом с текстом он не сможет сказать, откуда строка.
 */
import type { ChatRecord } from './chatShape.js';
import type { Message } from './messageShape.js';

export interface EnrichedMessage extends Message {
  chat_name?: string;
  chat_kind: string;
  /** Чат с собой: заметки не являются перепиской с кем-то, и это меняет чтение выдачи */
  is_self_chat: boolean;
}

export function enrichMessage(message: Message, chat: ChatRecord): EnrichedMessage {
  return {
    ...message,
    ...(chat.name !== undefined ? { chat_name: chat.name } : {}),
    chat_kind: chat.kind,
    is_self_chat: chat.is_self,
  };
}

export function enrichMessages(
  messages: readonly Message[],
  chat: ChatRecord,
): EnrichedMessage[] {
  return messages.map((message) => enrichMessage(message, chat));
}
