/**
 * `get_thread`: сообщения треда.
 *
 * ТРЕД ЭТО ЧАТ, и это не оборот речи, а решение, которое снимает половину поверхности:
 * тело треда читается тем же путём истории и тем же путём расшифровки, что и тело чата,
 * поэтому здесь нет ни своей пагинации, ни своей формы сообщения. В тред и пишут обычной
 * отправкой, передав адрес треда как адрес чата.
 *
 * АДРЕС ТРЕДА РАВЕН АДРЕСУ СТАРТОВОГО СООБЩЕНИЯ, И ЭТО ЗНАНИЕ ИЗ БАНДЛА. В бандле
 * веб-клиента тред сопоставляется сообщению равенством `thread.group_chat_id === message.sync_id`,
 * а локальное создание треда прямо присваивает адресу треда `sync_id` сообщения. Живой
 * пробой это НЕ подтверждено, поэтому выдача по `message_id` несёт `form_status:'bundle'`,
 * а сама выведенная догадка обязательно ПРОВЕРЯЕТСЯ по списку тредов: несуществующий тред
 * лучше объявить ненайденным, чем прочитать историю по выдуманному адресу.
 *
 * ФОРМА ЭЛЕМЕНТА СПИСКА ТРЕДОВ НАБЛЮДЕНА ЖИВЬЁМ, А СТРАНИЦА ТРЕДА НЕТ. Список тредов
 * прочитан живой пробой; страница треда читается тем же путём, что и история чата, но
 * живьём не подтверждена: в полигоне тредов нет. Поэтому чтение по готовому `thread_id`
 * метки неподтверждённости не несёт, пока сервер присылает признак продолжения, а без
 * него выдача честно объявляет неполноту.
 */
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
import { findThread } from '../../protocol/threads.js';
import type { ToolDeps } from './deps.js';

export interface GetThreadInput {
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
  form_status?: 'bundle' | 'unconfirmed';
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

const DERIVED_NOTE =
  'адрес треда выведен из message_id: в бандле веб-клиента адрес треда равен sync_id ' +
  'стартового сообщения. Живой пробой равенство не подтверждено, но существование треда с ' +
  'этим адресом проверено по списку тредов';

const HAS_MORE_NOTE =
  'признак продолжения истории живьём не наблюдался: сервер не прислал поля has_more, ' +
  'поэтому ключа has_more в ответе нет. Обход продолжайте, передавая next_before в before, ' +
  'пока очередная страница не окажется пустой';

const INVALID_INPUT_NEXT_STEP =
  'передайте thread_id, если он у вас есть, либо message_id сообщения, от которого начат тред';

const NOT_FOUND_NEXT_STEP =
  'проверьте, что тред действительно начат от этого сообщения и в этом чате: список тредов ' +
  'сервера его не содержит';

export async function getThread(deps: ToolDeps, input: GetThreadInput): Promise<GetThreadResult> {
  if (input.thread_id === undefined && input.message_id === undefined) {
    return {
      status: 'invalid_input',
      reason: 'не передан ни thread_id, ни message_id: адресовать тред нечем',
      next_step: INVALID_INPUT_NEXT_STEP,
    };
  }

  const resolved = await resolveChat(deps, input.chat);
  if (resolved.kind !== 'resolved') {
    return resolveFailure(resolved);
  }
  const chat = resolved.chat;

  const derived = input.thread_id === undefined;
  /* Ровно один из двух гарантированно есть: пустая пара отсеяна выше */
  const threadId = input.thread_id ?? (input.message_id as string);

  const thread = await findThread(deps, { chatId: chat.chat_id, threadId });
  if (thread === undefined) {
    return {
      status: 'thread_not_found',
      reason: derived
        ? `в чате ${chat.chat_id} нет треда, начатого от сообщения ${threadId}`
        : `в чате ${chat.chat_id} нет треда с адресом ${threadId}`,
      next_step: NOT_FOUND_NEXT_STEP,
    };
  }

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
  const messages = enrichMessages(toMessages(decrypted), chat);
  const decryptErrors = summarizeDecryptErrors(decrypted);
  const oldest = messages[0];

  const notes = [
    ...(derived ? [DERIVED_NOTE] : []),
    ...(page.hasMore === undefined ? [HAS_MORE_NOTE] : []),
  ];
  const formStatus = derived ? 'bundle' : notes.length > 0 ? 'unconfirmed' : undefined;

  deps.logger.debug('get_thread: страница треда собрана', {
    chatId: chat.chat_id,
    count: messages.length,
    derived,
    decryptFailed: decryptErrors?.count ?? 0,
  });

  return {
    status: 'ok',
    thread_id: thread.thread_id,
    chat_id: thread.chat_id,
    empty: messages.length === 0,
    messages,
    ...(oldest !== undefined ? { next_before: oldest.message_id } : {}),
    ...(page.hasMore !== undefined ? { has_more: page.hasMore } : {}),
    ...(formStatus !== undefined ? { form_status: formStatus, form_note: notes.join('; ') } : {}),
    ...(decryptErrors !== undefined ? { decrypt_error_summary: decryptErrors } : {}),
    ...(decryptErrors?.transient === true ? { next_step: DECRYPT_RETRY_NEXT_STEP } : {}),
  };
}
