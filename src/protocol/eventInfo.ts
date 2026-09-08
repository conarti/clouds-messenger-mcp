/**
 * Точечное чтение события по `sync_id`.
 *
 * ФОРМА ПОДТВЕРЖДЕНА ЖИВЬЁМ (проба на полигоне, 2026-09-08). Сервер принимает событие со
 * списком `sync_ids` и отвечает конвертом `{generated_at, info:[событие]}`: имя поля
 * ответа это `info`, внутри ровно одно искомое событие, и путь возвращается как
 * `addressed`. Метка неподтверждённости с адресного чтения поэтому снята, и выдача
 * `get_message` её больше не несёт.
 *
 * ПРОЧИЕ ВЛОЖЕННОСТИ ОСТАВЛЕНЫ ЗАПАСНЫМИ НАМЕРЕННО. Живьём наблюдена одна форма ответа,
 * но объявлять её единственной не за что: разбор по нескольким известным вариантам стоит
 * трёх строк, а промах по имени поля после релиза сервера стоил бы молчаливой потери
 * события.
 *
 * ЗАПАСНОЙ ПУТЬ ЧЕРЕЗ ИСТОРИЮ СОХРАНЁН на случай отказа сервера на адресном событии: он
 * тоже наблюдён живьём, а отказ адресного чтения ошибкой вызова не считается.
 *
 * ЗАПАСНОЙ ПУТЬ НЕ ИСПОЛЬЗУЕТ `fetchHistoryPage` НАМЕРЕННО. Та функция выбрасывает событие
 * курсора, потому что наружу курсор объявлен исключающим; здесь же нужно ровно оно, и
 * страница берётся сырым вызовом.
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
