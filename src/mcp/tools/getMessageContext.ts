/**
 * `get_message_context`: окно вокруг сообщения, N до и N после.
 *
 * ОКНО СТРОИТСЯ ТЕМИ ЖЕ ГРАНИЦАМИ, ЧТО И ПАГИНАЦИЯ. Отдельного события «контекст» на
 * проводе нет: сторона «до» это обычная страница назад от адреса, сторона «после» это та
 * же страница с направлением вперёд.
 *
 * ОБЕ СТОРОНЫ ОКНА И ЧТЕНИЕ САМОЙ МЕТКИ ПОДТВЕРЖДЕНЫ ЖИВЬЁМ: живая проба на полигоне
 * вернула непустое окно «после» и прочитала метку адресным событием, поэтому метки
 * неподтверждённости в выдаче больше нет.
 *
 * САМО СООБЩЕНИЕ НЕОБЯЗАТЕЛЬНО. Оно читается отдельно и отсутствует, если его уже нет;
 * окна вокруг при этом целы, потому что строятся границами, а не от найденного события.
 */
import { resolveChat } from '../../chat/resolveChat.js';
import { resolveFailure, type ChatResolveFailure } from '../../chat/resolveFailure.js';
import type { ChatRecord } from '../../protocol/chatShape.js';
import { decryptHistoryEvents, toMessages } from '../../protocol/decryptHistory.js';
import { enrichMessages, type EnrichedMessage } from '../../protocol/enrichMessage.js';
import { fetchEventBySyncId } from '../../protocol/eventInfo.js';
import { fetchHistoryPage, type HistoryDirection } from '../../protocol/history.js';
import type { ToolDeps } from './deps.js';

export interface GetMessageContextInput {
  chat: string;
  message_id: string;
  before_count?: number | undefined;
  after_count?: number | undefined;
}

export interface GetMessageContextOk {
  status: 'ok';
  chat_id: string;
  pivot_message_id: string;
  /** Сообщения ДО метки, от старых к новым */
  before: EnrichedMessage[];
  /** Само сообщение, если оно ещё живо */
  message?: EnrichedMessage;
  /** Сообщения ПОСЛЕ метки, от старых к новым */
  after: EnrichedMessage[];
}

export type GetMessageContextResult = GetMessageContextOk | ChatResolveFailure;

export const DEFAULT_CONTEXT_WINDOW = 10;

async function readSide(
  deps: ToolDeps,
  chat: ChatRecord,
  pivot: string,
  count: number,
  direction: HistoryDirection,
): Promise<EnrichedMessage[]> {
  if (count === 0) {
    return [];
  }
  const page = await fetchHistoryPage(deps, {
    chatId: chat.chat_id,
    limit: count,
    before: pivot,
    direction,
  });
  return enrichMessages(toMessages(await decryptHistoryEvents(deps, page.events)), chat);
}

export async function getMessageContext(
  deps: ToolDeps,
  input: GetMessageContextInput,
): Promise<GetMessageContextResult> {
  const beforeCount = input.before_count ?? DEFAULT_CONTEXT_WINDOW;
  const afterCount = input.after_count ?? DEFAULT_CONTEXT_WINDOW;

  const resolved = await resolveChat(deps, input.chat);
  if (resolved.kind !== 'resolved') {
    return resolveFailure(resolved);
  }
  const chat = resolved.chat;

  const lookup = await fetchEventBySyncId(deps, { chatId: chat.chat_id, syncId: input.message_id });
  const pivotMessages =
    lookup.event === undefined
      ? []
      : enrichMessages(toMessages(await decryptHistoryEvents(deps, [lookup.event])), chat);
  const pivotMessage = pivotMessages[0];

  const before = await readSide(deps, chat, input.message_id, beforeCount, 'backward');
  const after = await readSide(deps, chat, input.message_id, afterCount, 'forward');

  deps.logger.debug('get_message_context: окно собрано', {
    chatId: chat.chat_id,
    before: before.length,
    after: after.length,
    pivotFound: pivotMessage !== undefined,
  });

  return {
    status: 'ok',
    chat_id: chat.chat_id,
    pivot_message_id: input.message_id,
    before,
    ...(pivotMessage !== undefined ? { message: pivotMessage } : {}),
    after,
  };
}
