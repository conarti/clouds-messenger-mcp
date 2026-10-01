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
 * ТРЕД ЭТО ЧАТ И ДЛЯ ОТПРАВКИ. Кадр в тред снят с официального клиента: обычный `message_new`
 * в топике треда, адрес треда и во внешней нагрузке, и во внутреннем событии, получатели это
 * ключи треда, никакой метки родителя. Поэтому тред адресуется так же, как в `get_thread`:
 * адресом треда в `chat`, либо родительским чатом плюс `thread_id` или `message_id`.
 * `thread_join` при этом не отправляется никогда.
 *
 * Ошибкой MCP наружу уходит только отказ сервера, потому что чинить его вызывающему нечем.
 */
import { resolveChat, toThreadChat } from '../../chat/resolveChat.js';
import { resolveFailure, type ChatResolveFailure } from '../../chat/resolveFailure.js';
import { resolvePerson } from '../../chat/resolvePerson.js';
import type { ChatRecord } from '../../protocol/chatShape.js';
import { decryptHistoryEvents } from '../../protocol/decryptHistory.js';
import { fetchEventBySyncId } from '../../protocol/eventInfo.js';
import { UUID_PATTERN, type Mention } from '../../protocol/messageShape.js';
import {
  buildMessageNewRequest,
  buildReplyLink,
  sendMessageNew,
  type OutgoingMention,
  type ReplyLink,
} from '../../protocol/mutations.js';
import { fetchProfilesByHuids } from '../../protocol/profiles.js';
import { findThread } from '../../protocol/threads.js';
import { stringOr } from '../../util/json.js';
import { createRequestId } from '../../transport/requestId.js';
import type { ToolDeps } from './deps.js';
import type { ThreadNotFound } from './getThread.js';

export interface SendMessageInput {
  chat: string;
  text: string;
  /** Адрес сообщения (UUID) в том же чате, на которое отправляется ответ */
  reply_to?: string | undefined;
  /** Кого упомянуть: huid участника чата либо его однозначное имя */
  mentions?: string[] | undefined;
  /** Адрес треда внутри чата из `chat`: сообщение уходит в тред */
  thread_id?: string | undefined;
  /** Адрес стартового сообщения треда: альтернатива `thread_id` */
  message_id?: string | undefined;
}

/** Потолок длины текста; тем же числом ограничена схема параметра */
export const TEXT_MAX_LENGTH = 10_000;

export interface SendMessageSent {
  status: 'sent';
  chat_id: string;
  /** Имя чата, если оно у чата есть: по одному UUID человек не узнает адресата */
  chat_name?: string;
  /** Есть только у отправки в тред: тогда chat_id это адрес треда, а здесь его родитель */
  parent_chat_id?: string;
  /** Идентификатор отправки: он же адрес сообщения в истории */
  message_id: string;
  /** Метка сервера; отсутствует, если сервер её не прислал */
  inserted_at?: string;
  /** Есть только у ответа: адрес сообщения, на которое ответили */
  reply_to?: { message_id: string };
  /** Есть только при упоминаниях: кого упомянули, в порядке входа */
  mentions?: Mention[];
}

/** Цитируемое сообщение не найдено либо не годится для цитаты: кадр при этом не уходит */
export interface ReplyTargetNotFound {
  status: 'reply_target_not_found';
  reason: string;
  next_step: string;
}

/** Человек для упоминания не найден среди участников чата: кадр не уходит */
export interface MentionNotFound {
  status: 'mention_not_found';
  mention: string;
  reason: string;
  next_step: string;
}

/** Строка упоминания совпала с несколькими участниками: выбор за вызывающим */
export interface AmbiguousMention {
  status: 'ambiguous_mention';
  mention: string;
  candidates: Mention[];
  next_step: string;
}

/** Ни маркера, ни имени упомянутого в тексте нет: ставить плейсхолдер некуда */
export interface MentionNotInText {
  status: 'mention_not_in_text';
  mention: string;
  /** Что искалось в тексте, в порядке поиска */
  searched: string[];
  next_step: string;
}

export type MentionFailure = MentionNotFound | AmbiguousMention | MentionNotInText;

export type SendMessageResult =
  | SendMessageSent
  | ReplyTargetNotFound
  | MentionFailure
  | ThreadNotFound
  | ChatResolveFailure;

const THREAD_NOT_FOUND_NEXT_STEP =
  'адрес треда это message_id (sync_id) стартового сообщения, его видно по полю thread в ' +
  'истории чата; передайте его в thread_id вместе с родительским чатом в chat, либо сам адрес ' +
  'треда в chat';

/**
 * Чат назначения: сам резолвнутый чат либо тред внутри него. Промах по треду это статус без
 * единого кадра: отправить в основной чат то, что предназначалось треду, хуже, чем не
 * отправить вовсе.
 */
async function resolveTarget(
  deps: ToolDeps,
  chat: ChatRecord,
  threadId: string | undefined,
): Promise<ChatRecord | ThreadNotFound> {
  if (threadId === undefined) {
    return chat;
  }
  const notFound: ThreadNotFound = {
    status: 'thread_not_found',
    reason: `треда ${threadId} нет на сервере либо он начат не в чате ${chat.chat_id}`,
    next_step: THREAD_NOT_FOUND_NEXT_STEP,
  };
  if (chat.parent_chat_id !== undefined) {
    return threadId === chat.chat_id ? chat : notFound;
  }
  const found = await findThread(deps, { chatId: chat.chat_id, threadId });
  return found === undefined ? notFound : toThreadChat(found.thread, chat, found.participant);
}

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

const MENTION_NOT_FOUND_NEXT_STEP =
  'передайте в mentions huid участника этого чата либо его имя так, как его называет ' +
  'справка; упомянуть можно только участника чата';

const AMBIGUOUS_MENTION_NEXT_STEP =
  'имя совпало с несколькими участниками, выбор за вами: повторите вызов, передав в mentions ' +
  'huid одного из candidates';

const MENTION_NOT_IN_TEXT_NEXT_STEP =
  'поставьте в text место упоминания: маркер @{mention:<строка из mentions>} либо @Имя ' +
  'в том виде, в каком его назвала справка';

/** Упоминания с плейсхолдерами в тексте либо отказ; ни один кадр до этого не собирается */
interface PreparedMentions {
  text: string;
  mentions: OutgoingMention[];
}

/** Буква или цифра сразу за образцом означает, что образец это начало другого слова */
const WORD_CONTINUATION = /[\p{L}\p{N}]/u;

/**
 * Первое вхождение образца, за которым не продолжается слово: `@Иван Петров` не находится
 * внутри `@Иван Петрова`. Поиск строковый, поэтому символы образца ничего не значат.
 */
function findWholeOccurrence(body: string, pattern: string): number {
  let index = body.indexOf(pattern);
  while (index !== -1) {
    const next = body.charAt(index + pattern.length);
    if (!WORD_CONTINUATION.test(next)) {
      return index;
    }
    index = body.indexOf(pattern, index + 1);
  }
  return -1;
}

/**
 * Резолвит всех упомянутых и ставит плейсхолдеры. Для каждого входа в тексте ищется по
 * порядку: маркер `@{mention:<вход>}`, `@<полное имя из справки>`, `@<вход как передан>`.
 * Совпадение засчитывается только на границе слова. Каждый вход заменяет ОДНО вхождение
 * на `@{mention:<mention_id>}`: повтор того же человека в тексте остаётся текстом, а для
 * второго упоминания человека передают в mentions ещё раз (живьём повтор одного адресата в
 * одном сообщении не встречался). Первый же промах отменяет отправку целиком.
 */
async function prepareMentions(
  deps: ToolDeps,
  chat: ChatRecord,
  text: string,
  queries: readonly string[],
): Promise<PreparedMentions | MentionFailure> {
  const resolvedPeople: Array<{ query: string; person: Mention }> = [];
  for (const query of queries) {
    const resolvedPerson = await resolvePerson(deps, chat, query);
    if (resolvedPerson.kind === 'not_found') {
      return {
        status: 'mention_not_found',
        mention: query,
        reason: resolvedPerson.reason,
        next_step: MENTION_NOT_FOUND_NEXT_STEP,
      };
    }
    if (resolvedPerson.kind === 'ambiguous') {
      return {
        status: 'ambiguous_mention',
        mention: query,
        candidates: resolvedPerson.candidates,
        next_step: AMBIGUOUS_MENTION_NEXT_STEP,
      };
    }
    resolvedPeople.push({ query, person: resolvedPerson.person });
  }

  let body = text;
  const mentions: OutgoingMention[] = [];
  for (const { query, person } of resolvedPeople) {
    const searched = [
      ...new Set([`@{mention:${query}}`, `@${person.name}`, `@${query.trim()}`]),
    ];
    const pattern = searched.find((candidate) => findWholeOccurrence(body, candidate) !== -1);
    if (pattern === undefined) {
      return {
        status: 'mention_not_in_text',
        mention: query,
        searched,
        next_step: MENTION_NOT_IN_TEXT_NEXT_STEP,
      };
    }
    const mentionId = createRequestId();
    const index = findWholeOccurrence(body, pattern);
    body = `${body.slice(0, index)}@{mention:${mentionId}}${body.slice(index + pattern.length)}`;
    mentions.push({ mentionId, huid: person.huid, name: person.name });
  }
  return { text: body, mentions };
}

export async function sendMessage(
  deps: ToolDeps,
  input: SendMessageInput,
): Promise<SendMessageResult> {
  const resolved = await resolveChat(deps, input.chat);
  if (resolved.kind !== 'resolved') {
    return resolveFailure(resolved);
  }
  const target = await resolveTarget(deps, resolved.chat, input.thread_id ?? input.message_id);
  if ('status' in target) {
    return target;
  }
  const chat = target;

  let text = input.text;
  let mentions: OutgoingMention[] = [];
  if (input.mentions !== undefined && input.mentions.length > 0) {
    const prepared = await prepareMentions(deps, chat, input.text, input.mentions);
    if ('status' in prepared) {
      return prepared;
    }
    text = prepared.text;
    mentions = prepared.mentions;
  }

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
    parentChatId: chat.parent_chat_id,
    syncId,
    textLength: text.length,
    isReply: reply !== undefined,
    mentionCount: mentions.length,
  });
  const request = await buildMessageNewRequest({
    chat,
    text,
    syncId,
    ...(reply !== undefined ? { reply } : {}),
    ...(mentions.length > 0 ? { mentions } : {}),
    deps,
  });
  const ack = await sendMessageNew(deps, request);

  return {
    status: 'sent',
    chat_id: chat.chat_id,
    ...(chat.name !== undefined ? { chat_name: chat.name } : {}),
    ...(chat.parent_chat_id !== undefined ? { parent_chat_id: chat.parent_chat_id } : {}),
    message_id: syncId,
    ...(ack.inserted_at !== undefined ? { inserted_at: ack.inserted_at } : {}),
    ...(reply !== undefined ? { reply_to: { message_id: reply.sync_id } } : {}),
    ...(mentions.length > 0
      ? { mentions: mentions.map((mention) => ({ huid: mention.huid, name: mention.name })) }
      : {}),
  };
}
