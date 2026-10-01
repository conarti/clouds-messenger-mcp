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
 * СПИСОК СОДЕРЖИТ ТОЛЬКО ПОДПИСКИ. Живая проба (issue #5) показала: в `thread_list` попадают
 * лишь треды, где пользователь участник (`active: true`), а параметр `group_chat_id` сервер
 * ИГНОРИРУЕТ и на любой запрос отдаёт полный список. Поэтому сужения по чату здесь нет, а тред
 * вне списка ищется точечным `thread_info`: тот работает для любого треда, отвечает записью той
 * же формы плюс `active` и ничем не меняет участие (в отличие от `thread_join`, который делает
 * пользователя участником и потому не отправляется никогда).
 *
 * `counter` это ЧИСЛО ОТВЕТОВ в треде, а не непрочитанное: на живой пробе он совпал с длиной
 * истории треда и у чужих тредов, и у тредов, где все ответы свои.
 */
import { CHAT_LIST_SINCE_EPOCH, SYSTEM_TOPIC } from './chatList.js';
import { messageOf } from './errors.js';
import { PhoenixReplyError } from '../transport/ws/PhoenixClient.js';
import { asObject, numberOr, stringOr } from '../util/json.js';
import { parseIso } from '../util/timestamps.js';
import type { HistoryDeps } from './history.js';
import type { Message } from './messageShape.js';

export const THREAD_LIST_EVENT = 'thread_list';
export const THREAD_INFO_EVENT = 'thread_info';
/** Код отказа `thread_info` на неизвестный адрес: снят живой пробой */
const THREAD_NOT_FOUND_ERROR = 'thread_not_found';

/** Запись треда: адрес самого треда, адрес родительского чата и метки свежести */
export interface ThreadRecord {
  thread_id: string;
  /** Родительский чат: `group_chat_id` элемента списка */
  chat_id: string;
  /** `counter`: число ответов в треде, `0` возможен и у начатого треда */
  replies_count?: number;
  /** `last_event_sync_id`: адрес последнего события треда */
  last_message_id?: string;
  /** ISO последней активности треда */
  last_activity?: string;
  /**
   * `keys`: получатели обёртки контент-ключа. Живьём это тот же набор, что у родительского
   * чата; без него в тред нельзя отправить, потому что записи в списке чатов у треда нет.
   */
  key_ids: string[];
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
  const replies = numberOr(thread['counter']);
  const lastMessageId = stringOr(thread['last_event_sync_id']);
  const lastActivity =
    isoOrAbsent(thread['last_event_inserted_at']) ?? isoOrAbsent(thread['updated_at']);
  const rawKeys: unknown[] = Array.isArray(thread['keys']) ? thread['keys'] : [];
  return {
    thread_id: threadId,
    chat_id: chatId,
    ...(replies !== undefined ? { replies_count: replies } : {}),
    ...(lastMessageId !== undefined ? { last_message_id: lastMessageId } : {}),
    ...(lastActivity !== undefined ? { last_activity: lastActivity } : {}),
    key_ids: rawKeys.flatMap((entry) => {
      const keyId = stringOr(entry);
      return keyId === undefined ? [] : [keyId];
    }),
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

/** Список тредов, где пользователь участник. Сервер всегда отдаёт его целиком */
export async function fetchThreadList(deps: HistoryDeps): Promise<ThreadRecord[]> {
  const response = await deps.ws.request<unknown>(SYSTEM_TOPIC, THREAD_LIST_EVENT, {
    group_chat_id: null,
    /* Та же метка начала эпохи, что и у списка чатов: формат снят с живого запроса */
    since: CHAT_LIST_SINCE_EPOCH,
    request_version: deps.config.protocol.threadListRequestVersion,
  });
  const threads = extractThreads(response).flatMap((entry) => {
    const record = normalizeThread(entry);
    return record === undefined ? [] : [record];
  });
  deps.logger.debug('список тредов получен', { count: threads.length });
  return threads;
}

/** Запись `thread_info`: форма элемента списка плюс признак участия пользователя */
export interface ThreadInfoRecord extends ThreadRecord {
  active: boolean;
}

/**
 * Точечная справка о любом треде, включая чужой. Неизвестный адрес это законный исход
 * (`undefined`), а прочие отказы сервера пробрасываются, как и у списка тредов: молча
 * превратить сбой в «треда нет» значило бы солгать вызывающему.
 */
export async function fetchThreadInfo(
  deps: HistoryDeps,
  threadId: string,
): Promise<ThreadInfoRecord | undefined> {
  let response: unknown;
  try {
    response = await deps.ws.request<unknown>(SYSTEM_TOPIC, THREAD_INFO_EVENT, {
      thread_id: threadId,
    });
  } catch (error) {
    if (error instanceof PhoenixReplyError && error.code === THREAD_NOT_FOUND_ERROR) {
      return undefined;
    }
    throw error;
  }
  const raw = asObject(response)?.[THREAD_INFO_EVENT];
  const record = normalizeThread(raw);
  if (record === undefined) {
    deps.logger.warn('справка о треде пришла без нормализуемой записи', { threadId });
    return undefined;
  }
  return { ...record, active: asObject(raw)?.['active'] === true };
}

export interface FindThreadInput {
  chatId: string;
  threadId: string;
}

/** Откуда взят тред: список подписок либо точечная справка о треде */
export type ThreadSource = 'thread_list' | 'direct';

/** Найденный тред и то, откуда он взят */
export interface FoundThread {
  thread: ThreadRecord;
  source: ThreadSource;
  /** Участник ли пользователь: для списка всегда да, для справки это `active` */
  participant: boolean;
}

/**
 * Тред по адресу внутри известного чата.
 *
 * Сначала полный список подписок: тред, где пользователь участник, найдётся в нём. Промах
 * ничего не доказывает, потому что чужих тредов в списке нет, и тогда спрашивается
 * `thread_info`. Принадлежность чату проверяется ЛОКАЛЬНО в обоих случаях: тред другого
 * чата своим не считается.
 */
export async function findThread(
  deps: HistoryDeps,
  input: FindThreadInput,
): Promise<FoundThread | undefined> {
  const listed = (await fetchThreadList(deps)).find((thread) => thread.thread_id === input.threadId);
  if (listed !== undefined) {
    return listed.chat_id === input.chatId
      ? { thread: listed, source: 'thread_list', participant: true }
      : undefined;
  }
  const info = await fetchThreadInfo(deps, input.threadId);
  if (info === undefined || info.chat_id !== input.chatId) {
    return undefined;
  }
  const { active, ...thread } = info;
  return { thread, source: 'direct', participant: active };
}

/**
 * Предел одновременных справок `thread_info` на страницу: страница бывает в две сотни
 * сообщений, и залп справок по каждому чужому треду упирался бы в ограничение частоты.
 */
const THREAD_INFO_CONCURRENCY = 4;

/**
 * Число ответов для стартовых сообщений тредов страницы.
 *
 * Один полный список подписок на страницу, и только если на ней есть хоть один тред; треды
 * вне списка (чужие) переспрашиваются справкой `thread_info`. Любой сбой здесь НЕ ломает
 * выдачу: число ответов это дополнение, и сообщение остаётся с `thread`, но без
 * `replies_count`. Отказ списка не прячет счётчики насовсем: все треды страницы тогда
 * идут справками.
 */
export async function attachReplyCounts<T extends Message>(
  deps: HistoryDeps,
  messages: readonly T[],
): Promise<T[]> {
  const threadIds = [
    ...new Set(messages.flatMap((message) => (message.thread ? [message.thread.thread_id] : []))),
  ];
  if (threadIds.length === 0) {
    return [...messages];
  }

  const records = new Map<string, ThreadRecord>();
  try {
    for (const record of await fetchThreadList(deps)) {
      records.set(record.thread_id, record);
    }
  } catch (error) {
    deps.logger.warn('список тредов не получен, счётчики ответов берутся справками', {
      error: messageOf(error),
    });
  }

  const unlisted = threadIds.filter((threadId) => !records.has(threadId));
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < unlisted.length) {
      const threadId = unlisted[next] as string;
      next += 1;
      try {
        const info = await fetchThreadInfo(deps, threadId);
        if (info !== undefined) {
          records.set(threadId, info);
        }
      } catch (error) {
        deps.logger.warn('справка о треде не получена, тред отдан без счётчика ответов', {
          threadId,
          error: messageOf(error),
        });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(THREAD_INFO_CONCURRENCY, unlisted.length) }, worker),
  );

  return messages.map((message) => {
    if (message.thread === undefined) {
      return message;
    }
    const repliesCount = records.get(message.thread.thread_id)?.replies_count;
    return repliesCount === undefined
      ? message
      : { ...message, thread: { ...message.thread, replies_count: repliesCount } };
  });
}
