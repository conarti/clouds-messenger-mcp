/**
 * Страница истории чата: событие `events_history` в топике чата.
 *
 * КУРСОР. Наружу `before` объявлен ИСКЛЮЧАЮЩИМ: страница вернёт события строго старше
 * указанного `sync_id`. На проводе граница ВКЛЮЧАЮЩАЯ (живая проба: событие курсора
 * приезжает в странице), поэтому исключающая семантика держится здесь: событие с
 * `sync_id === before` выбрасывается из страницы явно. Так обход не зациклится и не
 * задвоит элемент.
 *
 * ПОРЯДОК. Сервер отдаёт `response.history` от НОВЫХ к старым (живая проба), но страница
 * всё равно сортируется здесь по `inserted_at` от старых к новым: порядок сервером не
 * обещан, а курсор ставится на край и обязан быть тем самым краем.
 *
 * ПРИЗНАК ПРОДОЛЖЕНИЯ НАБЛЮДЁН ЖИВЬЁМ: сервер присылает его полем `has_more_events`
 * (живая проба на полигоне; в том же ответе приезжают `history` и `generated_at`). Второе
 * имя оставлено на случай другой версии сервера. Признак по-прежнему только читается и
 * никогда не выдумывается из длины страницы: расшифровка ничего не выбрасывает, а вот
 * сервер вполне может отдать неполную страницу.
 */
import type { Config } from '../config/types.js';
import type { PhoenixClient } from '../transport/ws/types.js';
import type { Logger } from '../util/logger.js';
import { asObject, stringOr } from '../util/json.js';

/** Префикс топика чата: история и отправка живут в топике конкретного чата */
export const CHAT_TOPIC_PREFIX = 'groupchat:';
export const EVENTS_HISTORY_EVENT = 'events_history';

/** Направление обхода. `forward` взято из бандла веб-клиента и живьём не подтверждено */
export type HistoryDirection = 'backward' | 'forward';

export function chatTopic(chatId: string): string {
  return `${CHAT_TOPIC_PREFIX}${chatId}`;
}

export interface HistoryDeps {
  ws: PhoenixClient;
  config: Config;
  logger: Logger;
}

export interface EventsHistoryPayloadInput {
  groupChatId: string;
  limit: number;
  /** Курсор `sync_id`: с какого события сервер продолжает выдачу */
  before?: string;
  direction: HistoryDirection;
}

export function buildEventsHistoryPayload(input: EventsHistoryPayloadInput): Record<string, unknown> {
  return {
    group_chat_id: input.groupChatId,
    direction: input.direction,
    limit: input.limit,
    /*
     * Курсор едет ОТДЕЛЬНЫМ полем `sync_id`, а `skip_to_sync_id_event` это булев флаг
     * перемотки к нему (форма снята с живых кадров веб-клиента и подтверждена живой
     * пробой: кадр, где адрес курсора подставлен в сам флаг, сервер отвергает).
     */
    ...(input.before !== undefined ? { sync_id: input.before, skip_to_sync_id_event: true } : {}),
    /*
     * Служебные события чтения не нужны: они не несут тела и только съедали бы лимит
     * страницы, вытесняя настоящие сообщения.
     */
    skip_non_affecting_rc: false,
  };
}

export interface FetchHistoryPageInput {
  chatId: string;
  limit: number;
  before?: string;
  direction?: HistoryDirection;
}

export interface HistoryPage {
  /** Сырые события от старых к новым; расшифровка это отдельный шаг */
  events: Record<string, unknown>[];
  /**
   * Сколько элементов отдал сервер ДО выброса события курсора.
   *
   * Считать насыщенность страницы по `events` нельзя: с курсором оттуда всегда уходит один
   * элемент, и полная страница выглядела бы неполной, то есть обход останавливался бы на
   * первом же шаге и молча терял бы всю историю старше.
   */
  serverCount: number;
  /** Признак продолжения ТОЛЬКО если сервер его прислал */
  hasMore?: boolean;
}

/** Метка сортировки: у внешнего события своё время постановки, внутреннее ещё зашифровано */
function insertedAt(event: Record<string, unknown>): string {
  return stringOr(event['inserted_at']) ?? stringOr(event['timestamp']) ?? '';
}

/** Живое имя признака это `has_more_events`; второе оставлено запасным на случай ротации */
function readHasMore(response: Record<string, unknown> | undefined): boolean | undefined {
  for (const field of ['has_more_events', 'has_more'] as const) {
    const value = response?.[field];
    if (typeof value === 'boolean') {
      return value;
    }
  }
  return undefined;
}

export async function fetchHistoryPage(
  deps: HistoryDeps,
  input: FetchHistoryPageInput,
): Promise<HistoryPage> {
  const direction = input.direction ?? 'backward';
  const response = await deps.ws.request<unknown>(
    chatTopic(input.chatId),
    EVENTS_HISTORY_EVENT,
    buildEventsHistoryPayload({
      groupChatId: input.chatId,
      limit: input.limit,
      ...(input.before !== undefined ? { before: input.before } : {}),
      direction,
    }),
  );

  const body = asObject(response);
  const rawEvents = body?.['history'];
  const serverEvents = Array.isArray(rawEvents) ? rawEvents : [];
  const events = serverEvents
    .flatMap((entry) => {
      const event = asObject(entry);
      return event === undefined ? [] : [event];
    })
    /* Событие-курсор наружу не отдаётся: граница объявлена исключающей */
    .filter((event) => input.before === undefined || stringOr(event['sync_id']) !== input.before)
    .sort((left, right) => (insertedAt(left) < insertedAt(right) ? -1 : insertedAt(left) > insertedAt(right) ? 1 : 0));

  const hasMore = readHasMore(body);
  deps.logger.debug('страница истории получена', {
    chatId: input.chatId,
    direction,
    count: events.length,
    paged: input.before !== undefined,
  });

  return { events, serverCount: serverEvents.length, ...(hasMore !== undefined ? { hasMore } : {}) };
}
