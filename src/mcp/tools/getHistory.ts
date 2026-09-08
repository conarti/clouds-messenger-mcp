/**
 * `get_history`: страница переписки чата, курсором либо окном по датам.
 *
 * КУРСОР ИСКЛЮЧАЮЩИЙ. `before` это `sync_id`, и страница вернёт сообщения строго старше
 * него. Арифметики над курсором нет и быть не может: `sync_id` это UUID, а не метка
 * времени, и «сдвинуть границу на единицу», как это делалось на микросекундных метках,
 * здесь означало бы испортить адрес. Исключение обеспечивает слой протокола: он
 * выбрасывает из страницы само событие курсора.
 *
 * ФИЛЬТРЫ ДАТ КЛИЕНТСКИЕ. Сервер не принимает временных границ в истории, поэтому окно
 * набирается добором страниц назад, пока выдача не выйдет за нижнюю границу. Предел в
 * двадцать страниц страховочный: без него запрос с далёкой датой в живом чате уходил бы
 * листать историю до основания.
 *
 * ОТКАЗ РАСШИФРОВКИ ЕДЕТ ВНУТРИ УСПЕХА, И ПОЭТОМУ ОБЪЯВЛЯЕТСЯ ОТДЕЛЬНО. Нечитаемое
 * событие остаётся в выдаче с `decrypt_error`, а сама выдача сохраняет `status:"ok"`:
 * страница прочитана. Отказ службы ключей и обрыв сокета приезжают тем же полем, что и
 * чужой ключ, и без сводки вызывающий не отличает «сообщение не расшифровано» от «служба
 * ключей недоступна». Поэтому появляется `decrypt_error_summary` со слоями и признаком
 * `transient`: у транзиентного отказа повтор вызова осмыслен, у клиентского нет.
 *
 * ПРИЗНАК ПРОДОЛЖЕНИЯ НАБЛЮДЁН ЖИВЬЁМ. Сервер присылает его полем `has_more_events`
 * (живая проба на полигоне), и `has_more` в выдаче это оно и есть. Считать признак по длине
 * страницы по-прежнему нельзя: неполная страница у сервера означает не конец истории, а его
 * собственное решение, поэтому ключ появляется только из ответа сервера и никогда из
 * догадки.
 */
import { resolveChat } from '../../chat/resolveChat.js';
import { resolveFailure, type ChatResolveFailure } from '../../chat/resolveFailure.js';
import type { ChatRecord } from '../../protocol/chatShape.js';
import {
  DECRYPT_RETRY_NEXT_STEP,
  decryptHistoryEvents,
  summarizeDecryptErrors,
  toMessages,
  type DecryptErrorSummary,
} from '../../protocol/decryptHistory.js';
import { enrichMessages, type EnrichedMessage } from '../../protocol/enrichMessage.js';
import { fetchHistoryPage } from '../../protocol/history.js';
import { parseIso } from '../../util/timestamps.js';
import type { ToolDeps } from './deps.js';

export interface GetHistoryInput {
  chat: string;
  limit?: number | undefined;
  /** Курсор `sync_id`: вернуть сообщения строго старше него */
  before?: string | undefined;
  /** ISO, нижняя ВКЛЮЧАЮЩАЯ граница */
  from_date?: string | undefined;
  /** ISO, верхняя ИСКЛЮЧАЮЩАЯ граница */
  to_date?: string | undefined;
  /** ISO, нижняя ИСКЛЮЧАЮЩАЯ граница: строго после метки, альтернатива `from_date` */
  after?: string | undefined;
}

export interface GetHistoryOk {
  status: 'ok';
  chat_id: string;
  messages: EnrichedMessage[];
  /** Курсор следующей страницы: адрес самого старого сообщения; отсутствует у пустой страницы */
  next_before?: string;
  /** Признак продолжения от сервера: имя поля на проводе наблюдено живой пробой */
  has_more?: boolean;
  /** Есть, только если хоть одно событие не расшифровалось: отсутствие ключа значит «все читаемы» */
  decrypt_error_summary?: DecryptErrorSummary;
  /** Есть, только если отказ транзиентный: подсказка без действия обесценивает подсказку */
  next_step?: string;
}

export type GetHistoryResult = GetHistoryOk | ChatResolveFailure;

/** Страховочный предел добора страниц при фильтрах по датам */
export const MAX_HISTORY_PAGES = 20;

interface TimeWindow {
  lowerMillis?: number;
  /** Нижняя граница исключающая: так работает `after`, в отличие от `from_date` */
  lowerExclusive: boolean;
  upperMillis?: number;
}

/** `after` старше `from_date`: обе задают низ, и приоритет обязан быть объявлен, а не угадан */
function buildWindow(input: GetHistoryInput): TimeWindow {
  const lower = input.after ?? input.from_date;
  return {
    ...(lower !== undefined ? { lowerMillis: parseIso(lower).getTime() } : {}),
    lowerExclusive: input.after !== undefined,
    ...(input.to_date !== undefined ? { upperMillis: parseIso(input.to_date).getTime() } : {}),
  };
}

function hasWindow(window: TimeWindow): boolean {
  return window.lowerMillis !== undefined || window.upperMillis !== undefined;
}

/** Сообщение без метки времени в окно не попадает: сравнивать нечего, а гадать нельзя */
function withinWindow(message: EnrichedMessage, window: TimeWindow): boolean {
  if (!hasWindow(window)) {
    return true;
  }
  if (message.timestamp === undefined) {
    return false;
  }
  const millis = parseIso(message.timestamp).getTime();
  if (window.lowerMillis !== undefined) {
    if (window.lowerExclusive ? millis <= window.lowerMillis : millis < window.lowerMillis) {
      return false;
    }
  }
  return window.upperMillis === undefined || millis < window.upperMillis;
}

/** Дно окна пройдено: самое старое сообщение страницы уже старше нижней границы */
function belowWindow(message: EnrichedMessage | undefined, window: TimeWindow): boolean {
  if (window.lowerMillis === undefined || message?.timestamp === undefined) {
    return false;
  }
  return parseIso(message.timestamp).getTime() < window.lowerMillis;
}

async function readPage(
  deps: ToolDeps,
  chat: ChatRecord,
  limit: number,
  cursor: string | undefined,
): Promise<{
  messages: EnrichedMessage[];
  rawCount: number;
  hasMore?: boolean;
  decryptErrors?: DecryptErrorSummary;
}> {
  const page = await fetchHistoryPage(deps, {
    chatId: chat.chat_id,
    limit,
    ...(cursor !== undefined ? { before: cursor } : {}),
  });
  const decrypted = await decryptHistoryEvents(deps, page.events);
  const messages = enrichMessages(toMessages(decrypted), chat);
  const decryptErrors = summarizeDecryptErrors(decrypted);
  return {
    messages,
    rawCount: page.serverCount,
    ...(page.hasMore !== undefined ? { hasMore: page.hasMore } : {}),
    ...(decryptErrors !== undefined ? { decryptErrors } : {}),
  };
}

/**
 * Сводки страниц в одну. Считается по ВСЕМ прочитанным страницам, а не по отданному срезу:
 * отказ службы ключей на добранной странице это тот же отказ, и умолчать о нём потому,
 * что событие не влезло в лимит, значит соврать о полноте прочитанного.
 */
function mergeSummaries(
  parts: readonly DecryptErrorSummary[],
): DecryptErrorSummary | undefined {
  if (parts.length === 0) {
    return undefined;
  }
  const layers = [...new Set(parts.flatMap((part) => part.layers))].sort();
  return {
    count: parts.reduce((total, part) => total + part.count, 0),
    layers,
    transient: parts.some((part) => part.transient),
  };
}

export async function getHistory(deps: ToolDeps, input: GetHistoryInput): Promise<GetHistoryResult> {
  const limit = input.limit ?? deps.config.limits.historyDefaultLimit;
  const resolved = await resolveChat(deps, input.chat);
  if (resolved.kind !== 'resolved') {
    return resolveFailure(resolved);
  }
  const chat = resolved.chat;
  const window = buildWindow(input);
  const maxPages = hasWindow(window) ? MAX_HISTORY_PAGES : 1;

  /* Накопитель идёт от новых к старым: страница берётся с новейшего края окна */
  const collected: EnrichedMessage[] = [];
  const decryptParts: DecryptErrorSummary[] = [];
  let cursor = input.before;
  let serverHasMore: boolean | undefined;
  let pages = 0;

  while (pages < maxPages) {
    const page = await readPage(deps, chat, limit, cursor);
    pages += 1;
    if (page.hasMore !== undefined) {
      serverHasMore = page.hasMore;
    }
    if (page.decryptErrors !== undefined) {
      decryptParts.push(page.decryptErrors);
    }
    for (const message of [...page.messages].reverse()) {
      if (withinWindow(message, window)) {
        collected.push(message);
      }
    }
    const oldest = page.messages[0];
    if (oldest === undefined || page.rawCount < limit) {
      break;
    }
    cursor = oldest.message_id;
    if (collected.length >= limit || belowWindow(oldest, window)) {
      break;
    }
  }

  const messages = collected.slice(0, limit).reverse();
  const oldestReturned = messages[0];
  const decryptErrors = mergeSummaries(decryptParts);

  deps.logger.debug('get_history: страница собрана', {
    chatId: chat.chat_id,
    count: messages.length,
    pages,
    windowed: hasWindow(window),
    decryptFailed: decryptErrors?.count ?? 0,
  });

  return {
    status: 'ok',
    chat_id: chat.chat_id,
    messages,
    ...(oldestReturned !== undefined ? { next_before: oldestReturned.message_id } : {}),
    ...(serverHasMore !== undefined ? { has_more: serverHasMore } : {}),
    ...(decryptErrors !== undefined ? { decrypt_error_summary: decryptErrors } : {}),
    ...(decryptErrors?.transient === true ? { next_step: DECRYPT_RETRY_NEXT_STEP } : {}),
  };
}
