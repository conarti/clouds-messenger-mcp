/**
 * Треды: список тредов пользователя и чтение тела треда.
 *
 * ТРЕД ЭТО ЧАТ. У него собственный UUID, и всё, что умеет обычный чат, работает в нём тем
 * же способом: история треда читается тем же событием истории в топике самого треда, а не
 * отдельной механикой. Поэтому здесь нет ни своего кодека сообщений, ни своей расшифровки:
 * тело треда собирает `history` плюс `decryptHistory`, как и тело чата.
 *
 * ФОРМА ЭЛЕМЕНТА СПИСКА НАБЛЮДЕНА ЖИВЬЁМ (findings.md, P4; p45-result.json): `thread_id`,
 * `group_chat_id` РОДИТЕЛЬСКОГО чата, `counter`, `keys`, `last_event_sync_id`,
 * `last_event_inserted_at`, `inserted_at`, `updated_at`, `read_position_at`, `sorting_*`.
 * Метки неподтверждённости у этой формы нет.
 *
 * ЗАПРОС БЕЗ ЧАТА НАБЛЮДЁН ЖИВЬЁМ, С ЧАТОМ НЕТ. Живая проба спрашивала список с
 * `group_chat_id: null` и получила ВСЕ треды учётной записи. Сужение по конкретному чату
 * взято из кадров веб-клиента (bundle) и живьём не проверялось, поэтому пустой ответ на
 * суженный запрос НЕ считается доказательством отсутствия треда: вызывающий переспрашивает
 * полным списком (см. `findThread`).
 */
import { CHAT_LIST_SINCE_EPOCH, SYSTEM_TOPIC } from './chatList.js';
import { asObject, numberOr, stringOr } from '../util/json.js';
import { parseIso } from '../util/timestamps.js';
import type { HistoryDeps } from './history.js';

export const THREAD_LIST_EVENT = 'thread_list';

/** Запись треда: адрес самого треда, адрес родительского чата и метки свежести */
export interface ThreadRecord {
  thread_id: string;
  /** Родительский чат: `group_chat_id` элемента списка */
  chat_id: string;
  unread_count?: number;
  /** `last_event_sync_id`: адрес последнего события треда */
  last_message_id?: string;
  /** ISO последней активности треда */
  last_activity?: string;
}

/** Непонятная метка времени приравнивается к отсутствующей: гадать про формат нечем */
function isoOrAbsent(value: unknown): string | undefined {
  const raw = stringOr(value);
  if (raw === undefined) {
    return undefined;
  }
  try {
    return parseIso(raw).toISOString();
  } catch {
    return undefined;
  }
}

/**
 * Сырая запись треда во внутреннюю. Запись без `thread_id` не нормализуется: тред, который
 * нечем адресовать, наружу отдавать нельзя, а выдумывать ему адрес тем более.
 */
export function normalizeThread(raw: unknown): ThreadRecord | undefined {
  const thread = asObject(raw);
  const threadId = stringOr(thread?.['thread_id']);
  const chatId = stringOr(thread?.['group_chat_id']);
  if (thread === undefined || threadId === undefined || chatId === undefined) {
    return undefined;
  }
  const unread = numberOr(thread['counter']);
  const lastMessageId = stringOr(thread['last_event_sync_id']);
  const lastActivity =
    isoOrAbsent(thread['last_event_inserted_at']) ?? isoOrAbsent(thread['updated_at']);
  return {
    thread_id: threadId,
    chat_id: chatId,
    ...(unread !== undefined ? { unread_count: unread } : {}),
    ...(lastMessageId !== undefined ? { last_message_id: lastMessageId } : {}),
    ...(lastActivity !== undefined ? { last_activity: lastActivity } : {}),
  };
}

/** Конверт ответа: живая проба принимала оба имени поля, и какое из них пришло, не записано */
function extractThreads(response: unknown): unknown[] {
  const body = asObject(response);
  for (const field of [THREAD_LIST_EVENT, 'threads'] as const) {
    const candidate = body?.[field];
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }
  return Array.isArray(response) ? response : [];
}

/**
 * Список тредов. Без `chatId` спрашивается всё (форма наблюдена живьём), с `chatId` сервер
 * просят сузить выдачу до одного чата (форма из бандла).
 */
export async function fetchThreadList(
  deps: HistoryDeps,
  chatId?: string,
): Promise<ThreadRecord[]> {
  const response = await deps.ws.request<unknown>(SYSTEM_TOPIC, THREAD_LIST_EVENT, {
    group_chat_id: chatId ?? null,
    /* Та же метка начала эпохи, что и у списка чатов: формат снят с живого запроса */
    since: CHAT_LIST_SINCE_EPOCH,
    request_version: deps.config.protocol.threadListRequestVersion,
  });
  const threads = extractThreads(response).flatMap((entry) => {
    const record = normalizeThread(entry);
    return record === undefined ? [] : [record];
  });
  deps.logger.debug('список тредов получен', {
    count: threads.length,
    narrowed: chatId !== undefined,
  });
  return threads;
}

export interface FindThreadInput {
  chatId: string;
  threadId: string;
}

/**
 * Тред по адресу внутри известного чата.
 *
 * ДВА ЗАХОДА, И ВТОРОЙ НЕ ЛИШНИЙ. Сначала спрашивается суженный список (дёшево), но пустой
 * ответ на него ничего не доказывает: сужение живьём не проверялось, и сервер, который его
 * не понимает, вернул бы пустоту на существующий тред. Поэтому пустой ответ переспрашивается
 * полной выдачей, форма которой наблюдена живьём.
 *
 * Принадлежность чату проверяется ЛОКАЛЬНО в обоих случаях: сервер, игнорирующий сужение,
 * иначе отдал бы чужой тред как свой.
 */
export async function findThread(
  deps: HistoryDeps,
  input: FindThreadInput,
): Promise<ThreadRecord | undefined> {
  const narrowed = await fetchThreadList(deps, input.chatId);
  const found = narrowed.find(
    (thread) => thread.thread_id === input.threadId && thread.chat_id === input.chatId,
  );
  if (found !== undefined || narrowed.length > 0) {
    return found;
  }
  const full = await fetchThreadList(deps);
  return full.find(
    (thread) => thread.thread_id === input.threadId && thread.chat_id === input.chatId,
  );
}
