/**
 * `get_thread`: сообщения треда.
 *
 * ТРЕД ЭТО ЧАТ, и это не оборот речи, а решение, которое снимает половину поверхности:
 * тело треда читается тем же путём истории и тем же путём расшифровки, что и тело чата,
 * поэтому здесь нет ни своей пагинации, ни своей формы сообщения. В тред и пишут обычной
 * отправкой, передав адрес треда как адрес чата.
 *
 * АДРЕС ТРЕДА РАВЕН АДРЕСУ СТАРТОВОГО СООБЩЕНИЯ, И ЭТО ПОДТВЕРЖДЕНО ЖИВЬЁМ: `thread_id`
 * совпадает с `sync_id` стартового сообщения (нашим `message_id`), а внутренний `msg_id`
 * адресом треда не является. Поэтому вызов по `message_id` ничем не помечается, но
 * существование треда всё равно ПРОВЕРЯЕТСЯ: несуществующий тред лучше объявить
 * ненайденным, чем прочитать историю по выдуманному адресу.
 *
 * ЧУЖОЙ ТРЕД ТОЖЕ ЧИТАЕТСЯ. Список тредов содержит только подписки пользователя, поэтому
 * промах по нему переспрашивается справкой `thread_info` (см. `findThread`). Выдача говорит,
 * откуда взят тред (`source`) и участник ли пользователь (`participant`). Участие при чтении
 * не меняется: `thread_join` не отправляется никогда.
 *
 * СТРАНИЦА ТРЕДА ПРОЧИТАНА ЖИВЬЁМ. Живая проба (issue #5) прочитала историю тредов тем же
 * путём, что и историю чата, и сервер прислал признак продолжения `has_more_events`. Поэтому
 * выдача метки неподтверждённости не несёт, пока сервер присылает признак продолжения, а без
 * него выдача честно объявляет неполноту.
 */
import { parseMessageLink } from '../../chat/messageLink.js';
import { resolveChat } from '../../chat/resolveChat.js';
import { resolveFailure, type ChatResolveFailure } from '../../chat/resolveFailure.js';
import {
  DECRYPT_RETRY_NEXT_STEP,
  decryptHistoryEvents,
  summarizeDecryptErrors,
  toMessages,
  type DecryptErrorSummary,
} from '../../protocol/decryptHistory.js';
import { enrichMessages, type EnrichedMessage } from '../../protocol/enrichMessage.js';
import { fetchHistoryPage } from '../../protocol/history.js';
import { UUID_PATTERN } from '../../protocol/messageShape.js';
import {
  attachReplyCounts,
  findThread,
  type FoundThread,
  type ThreadSource,
} from '../../protocol/threads.js';
import type { ToolDeps } from './deps.js';

export interface GetThreadInput {
  /** Родительский чат треда либо адрес самого треда: тогда thread_id и message_id не нужны */
  chat: string;
  /** Готовый адрес треда: путь без догадок */
  thread_id?: string | undefined;
  /** Адрес сообщения, от которого начат тред: адрес треда выводится из него */
  message_id?: string | undefined;
  limit?: number | undefined;
  before?: string | undefined;
}

export interface GetThreadOk {
  status: 'ok';
  thread_id: string;
  /** РОДИТЕЛЬСКИЙ чат треда: у самого треда ни имени, ни отдельной записи в списке чатов нет */
  chat_id: string;
  /**
   * Событий не отдано. Это либо тред, который ещё не материализован сообщением, либо конец
   * обхода, если был передан `before`: различить их может только сам вызывающий по курсору.
   */
  empty: boolean;
  messages: EnrichedMessage[];
  next_before?: string;
  /** Только из ответа сервера; иначе ключа нет, а неполнота объявлена в form_status */
  has_more?: boolean;
  /** Откуда взят тред: `direct` означает точечную справку, а не список подписок */
  source: ThreadSource;
  /** Участник ли пользователь треда; чтение участие не меняет */
  participant: boolean;
  form_status?: 'unconfirmed';
  form_note?: string;
  /** Есть, только если хоть одно событие страницы не расшифровалось */
  decrypt_error_summary?: DecryptErrorSummary;
  /** Есть, только если отказ транзиентный: тот же смысл, что и у `get_history` */
  next_step?: string;
}

export interface ThreadNotFound {
  status: 'thread_not_found';
  reason: string;
  next_step: string;
}

export interface ThreadInputInvalid {
  status: 'invalid_input';
  reason: string;
  next_step: string;
}

export type GetThreadResult = GetThreadOk | ThreadNotFound | ThreadInputInvalid | ChatResolveFailure;

/** Дефолт лимита страницы треда: тред заметно короче чата, и полсотни здесь избыточны */
export const DEFAULT_THREAD_LIMIT = 40;

const HAS_MORE_NOTE =
  'признак продолжения истории живьём не наблюдался: сервер не прислал поля has_more, ' +
  'поэтому ключа has_more в ответе нет. Обход продолжайте, передавая next_before в before, ' +
  'пока очередная страница не окажется пустой';

const INVALID_INPUT_NEXT_STEP =
  'передайте thread_id, если он у вас есть, либо message_id сообщения, от которого начат тред, ' +
  'либо сам адрес треда в chat';

const NOT_FOUND_NEXT_STEP =
  'адрес треда это message_id (sync_id) стартового сообщения; сообщения, от которых начаты ' +
  'треды, видны по полю thread в истории чата';

function threadNotFound(threadId: string, chatId: string): ThreadNotFound {
  return {
    status: 'thread_not_found',
    reason: `треда ${threadId} нет на сервере либо он начат не в чате ${chatId}, а в другом`,
    next_step: NOT_FOUND_NEXT_STEP,
  };
}

function invalidInput(): ThreadInputInvalid {
  return {
    status: 'invalid_input',
    reason: 'не передан ни thread_id, ни message_id, а в chat не адрес треда: адресовать тред нечем',
    next_step: INVALID_INPUT_NEXT_STEP,
  };
}

export async function getThread(deps: ToolDeps, input: GetThreadInput): Promise<GetThreadResult> {
  const requestedThreadId = input.thread_id ?? input.message_id;
  /* Имя чата адресом треда не бывает: без идентификаторов такой вызов к серверу не идёт */
  const chatMayBeThread =
    UUID_PATTERN.test(input.chat.trim()) || parseMessageLink(input.chat) !== undefined;
  if (requestedThreadId === undefined && !chatMayBeThread) {
    return invalidInput();
  }

  const resolved = await resolveChat(deps, input.chat);
  if (resolved.kind !== 'resolved') {
    return resolveFailure(resolved);
  }
  const chat = resolved.chat;

  let found: FoundThread | undefined;
  if (chat.parent_chat_id !== undefined) {
    /*
     * В chat уже адрес треда: резолв нашёл его справкой, и второй раз тред не ищется. Без этой
     * ветки поиск сверял бы родителя треда с самим тредом и не находил его никогда.
     */
    if (requestedThreadId !== undefined && requestedThreadId !== chat.chat_id) {
      return threadNotFound(requestedThreadId, chat.parent_chat_id);
    }
    found = {
      thread: {
        thread_id: chat.chat_id,
        chat_id: chat.parent_chat_id,
        key_ids: chat.key_ids,
      },
      source: 'direct',
      participant: chat.thread_participant ?? false,
    };
  } else {
    if (requestedThreadId === undefined) {
      return invalidInput();
    }
    found = await findThread(deps, { chatId: chat.chat_id, threadId: requestedThreadId });
    if (found === undefined) {
      return threadNotFound(requestedThreadId, chat.chat_id);
    }
  }
  const thread = found.thread;

  const limit = input.limit ?? DEFAULT_THREAD_LIMIT;
  const page = await fetchHistoryPage(deps, {
    chatId: thread.thread_id,
    limit,
    ...(input.before !== undefined ? { before: input.before } : {}),
  });
  /*
   * Контекст чата в сообщениях треда это РОДИТЕЛЬСКИЙ чат: у треда своего имени нет, а
   * `chat_id` самого сообщения при этом равен адресу треда, потому что тред и есть его чат.
   */
  const decrypted = await decryptHistoryEvents(deps, page.events);
  const messages = await attachReplyCounts(deps, enrichMessages(toMessages(decrypted), chat));
  const decryptErrors = summarizeDecryptErrors(decrypted);
  const oldest = messages[0];

  deps.logger.debug('get_thread: страница треда собрана', {
    chatId: chat.chat_id,
    count: messages.length,
    source: found.source,
    decryptFailed: decryptErrors?.count ?? 0,
  });

  return {
    status: 'ok',
    thread_id: thread.thread_id,
    chat_id: thread.chat_id,
    source: found.source,
    participant: found.participant,
    empty: messages.length === 0,
    messages,
    ...(oldest !== undefined ? { next_before: oldest.message_id } : {}),
    ...(page.hasMore !== undefined ? { has_more: page.hasMore } : {}),
    ...(page.hasMore === undefined ? { form_status: 'unconfirmed', form_note: HAS_MORE_NOTE } : {}),
    ...(decryptErrors !== undefined ? { decrypt_error_summary: decryptErrors } : {}),
    ...(decryptErrors?.transient === true ? { next_step: DECRYPT_RETRY_NEXT_STEP } : {}),
  };
}
