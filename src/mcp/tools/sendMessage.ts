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
import type { ChatRecord } from '../../protocol/chatShape.js';
import { decryptHistoryEvents } from '../../protocol/decryptHistory.js';
import { fetchEventBySyncId } from '../../protocol/eventInfo.js';
import { UUID_PATTERN } from '../../protocol/messageShape.js';
import {
  buildMessageNewRequest,
  buildReplyLink,
  sendMessageNew,
  type ReplyLink,
} from '../../protocol/mutations.js';
import { fetchProfilesByHuids } from '../../protocol/profiles.js';
import { stringOr } from '../../util/json.js';
import { createRequestId } from '../../transport/requestId.js';
import type { ToolDeps } from './deps.js';

export interface SendMessageInput {
  chat: string;
  text: string;
  /** Адрес сообщения (UUID) в том же чате, на которое отправляется ответ */
  reply_to?: string | undefined;
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
  /** Есть только у ответа: адрес сообщения, на которое ответили */
  reply_to?: { message_id: string };
}

/** Цитируемое сообщение не найдено либо не годится для цитаты: кадр при этом не уходит */
export interface ReplyTargetNotFound {
  status: 'reply_target_not_found';
  reason: string;
  next_step: string;
}

export type SendMessageResult = SendMessageSent | ReplyTargetNotFound | ChatResolveFailure;

const REPLY_TARGET_NEXT_STEP =
  'сверьте reply_to: возьмите message_id текстового сообщения из выдачи get_history этого же ' +
  'чата. Сообщение могло быть удалено либо принадлежать другому чату';

function replyTargetNotFound(reason: string): ReplyTargetNotFound {
  return { status: 'reply_target_not_found', reason, next_step: REPLY_TARGET_NEXT_STEP };
}

/** Имя автора цитаты; отказ справки отправку не роняет, имя тогда остаётся пустым */
async function authorName(deps: ToolDeps, huid: string): Promise<string> {
  try {
    return (await fetchProfilesByHuids(deps, [huid])).get(huid)?.name ?? '';
  } catch (error) {
    deps.logger.warn('send_message: справка о профилях не ответила, имя автора цитаты пустое', {
      error: String(error),
    });
    return '';
  }
}

/**
 * Связь ответа из цитируемого сообщения. Цитата собирается из самого сообщения, а не со слов
 * вызывающего: адрес, текст и автор берутся из расшифрованного события того же чата, а имя
 * автора из справки о профилях. Справка, не назвавшая автора, даёт пустое имя: так цитата
 * встречается и живьём, а придуманное имя хуже пустого.
 */
async function resolveReplyLink(
  deps: ToolDeps,
  chat: ChatRecord,
  replyTo: string,
): Promise<ReplyLink | ReplyTargetNotFound> {
  if (!UUID_PATTERN.test(replyTo)) {
    return replyTargetNotFound(`reply_to ${replyTo} не похож на идентификатор сообщения (UUID)`);
  }
  const lookup = await fetchEventBySyncId(deps, { chatId: chat.chat_id, syncId: replyTo });
  const found = lookup.event;
  /* Адресное чтение ищет по всем чатам, поэтому чужой чат цитируемого это тоже промах */
  if (found === undefined || stringOr(found['group_chat_id']) !== chat.chat_id) {
    return replyTargetNotFound(`в чате ${chat.chat_id} нет сообщения ${replyTo}`);
  }
  const [decrypted] = await decryptHistoryEvents(deps, [found]);
  if (decrypted?.inner === undefined) {
    return replyTargetNotFound(`сообщение ${replyTo} не расшифровано, цитату собрать не из чего`);
  }
  const author = stringOr(decrypted.inner['from']) ?? stringOr(found['sender']);
  const link = buildReplyLink({
    quotedInner: decrypted.inner,
    ...(author !== undefined ? { quotedSender: author } : {}),
    quotedMessageId: replyTo,
    chat,
    sourceName: author === undefined ? '' : await authorName(deps, author),
  });
  return (
    link ??
    replyTargetNotFound(
      `сообщение ${replyTo} не текст и не ссылка: цитировать можно только их, форма цитаты ` +
        'файловых сообщений не снята',
    )
  );
}

export async function sendMessage(
  deps: ToolDeps,
  input: SendMessageInput,
): Promise<SendMessageResult> {
  const resolved = await resolveChat(deps, input.chat);
  if (resolved.kind !== 'resolved') {
    return resolveFailure(resolved);
  }
  const chat = resolved.chat;

  let reply: ReplyLink | undefined;
  if (input.reply_to !== undefined) {
    const resolvedReply = await resolveReplyLink(deps, chat, input.reply_to);
    if ('status' in resolvedReply) {
      return resolvedReply;
    }
    reply = resolvedReply;
  }
  const syncId = createRequestId();

  deps.logger.info('send_message: отправка', {
    chatId: chat.chat_id,
    syncId,
    textLength: input.text.length,
    isReply: reply !== undefined,
  });
  const request = await buildMessageNewRequest({
    chat,
    text: input.text,
    syncId,
    ...(reply !== undefined ? { reply } : {}),
    deps,
  });
  const ack = await sendMessageNew(deps, request);

  return {
    status: 'sent',
    chat_id: chat.chat_id,
    ...(chat.name !== undefined ? { chat_name: chat.name } : {}),
    message_id: syncId,
    ...(ack.inserted_at !== undefined ? { inserted_at: ack.inserted_at } : {}),
    ...(reply !== undefined ? { reply_to: { message_id: reply.sync_id } } : {}),
  };
}
