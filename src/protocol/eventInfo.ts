/**
 * Точечное чтение события по `sync_id`.
 *
 * ФОРМА НЕ ПОДТВЕРЖДЕНА ЖИВЬЁМ. Событие `event_info` со списком `sync_ids` взято из бандла
 * веб-клиента, а не снято живой пробой: ни имя поля ответа, ни его вложенность не
 * наблюдались. Поэтому ответ разбирается устойчиво по трём известным вариантам, а отказ
 * сервера на этом событии не считается ошибкой вызова: он переводит чтение на запасной
 * путь через историю, форма которой наблюдена живьём.
 *
 * ЗАПАСНОЙ ПУТЬ НЕ ИСПОЛЬЗУЕТ `fetchHistoryPage` НАМЕРЕННО. Та функция выбрасывает событие
 * курсора, потому что наружу курсор объявлен исключающим; здесь же нужно ровно оно, и
 * страница берётся сырым вызовом.
 *
 * ЖИВАЯ ПРОБА ПРОШЛА ЗАПАСНЫМ ПУТЁМ. На полигоне адресное чтение события не дало (путь
 * `history_scan`), а страница истории вернула искомое событие вместе с курсором. Метка
 * неподтверждённости адресного пути поэтому остаётся, а запасной путь наблюдён живьём.
 */
import { PhoenixReplyError } from '../transport/ws/PhoenixClient.js';
import { asObject, stringOr } from '../util/json.js';
import { SYSTEM_TOPIC } from './chatList.js';
import {
  EVENTS_HISTORY_EVENT,
  buildEventsHistoryPayload,
  chatTopic,
  type HistoryDeps,
} from './history.js';

export const EVENT_INFO_EVENT = 'event_info';

/**
 * Сколько событий берёт запасной проход. Три, а не одно: живая проба показала ВКЛЮЧАЮЩУЮ
 * границу курсора, но запас на случай другой версии сервера дешевле, чем промах по
 * единственному событию.
 */
export const EVENT_LOOKUP_FALLBACK_LIMIT = 3;

export interface EventLookup {
  event?: Record<string, unknown>;
  /**
   * Каким путём нашлось: адресным чтением либо проходом по истории. Значения намеренно
   * НЕ повторяют имён событий провода: их читает слой инструментов, а туда знание о
   * проводе не поднимается.
   */
  via: 'addressed' | 'history_scan';
}

/** Живое имя поля ответа это `info`; остальные вложенности оставлены запасными */
function extractEvents(response: unknown): Record<string, unknown>[] {
  const body = asObject(response);
  const candidates = [body?.['info'], body?.[EVENT_INFO_EVENT], body?.['events'], response];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.flatMap((entry) => {
        const event = asObject(entry);
        return event === undefined ? [] : [event];
      });
    }
  }
  return [];
}

function findBySyncId(
  events: readonly Record<string, unknown>[],
  syncId: string,
): Record<string, unknown> | undefined {
  return events.find((event) => stringOr(event['sync_id']) === syncId);
}

export interface FetchEventInput {
  chatId: string;
  syncId: string;
}

export async function fetchEventBySyncId(
  deps: HistoryDeps,
  input: FetchEventInput,
): Promise<EventLookup> {
  const direct = await requestEventInfo(deps, input.syncId);
  const found = findBySyncId(direct, input.syncId);
  if (found !== undefined) {
    return { event: found, via: 'addressed' };
  }

  const response = await deps.ws.request<unknown>(
    chatTopic(input.chatId),
    EVENTS_HISTORY_EVENT,
    buildEventsHistoryPayload({
      groupChatId: input.chatId,
      limit: EVENT_LOOKUP_FALLBACK_LIMIT,
      before: input.syncId,
      direction: 'backward',
    }),
  );
  const history = extractHistory(response);
  const scanned = findBySyncId(history, input.syncId);
  return { ...(scanned !== undefined ? { event: scanned } : {}), via: 'history_scan' };
}

function extractHistory(response: unknown): Record<string, unknown>[] {
  const raw = asObject(response)?.['history'];
  return (Array.isArray(raw) ? raw : []).flatMap((entry) => {
    const event = asObject(entry);
    return event === undefined ? [] : [event];
  });
}

/**
 * Отказ сервера на неподтверждённом событии это не ошибка вызова, а сигнал, что путь
 * неверный: он гасится и уводит на запасной. Всё остальное (обрыв, таймаут, отказ
 * авторизации) пробрасывается, потому что запасной путь его не вылечит.
 */
async function requestEventInfo(
  deps: HistoryDeps,
  syncId: string,
): Promise<Record<string, unknown>[]> {
  try {
    return extractEvents(
      await deps.ws.request<unknown>(SYSTEM_TOPIC, EVENT_INFO_EVENT, { sync_ids: [syncId] }),
    );
  } catch (error) {
    if (!(error instanceof PhoenixReplyError)) {
      throw error;
    }
    deps.logger.debug('адресное чтение события отклонено сервером, идём через историю', {
      code: error.code,
    });
    return [];
  }
}
