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
import { containerChatOf, resolveChat } from '../../chat/resolveChat.js';
import { resolveFailure, type ChatResolveFailure } from '../../chat/resolveFailure.js';
import type { ChatRecord } from '../../protocol/chatShape.js';
import { decryptHistoryEvents, toMessages } from '../../protocol/decryptHistory.js';
import { enrichMessages, type EnrichedMessage } from '../../protocol/enrichMessage.js';
import { fetchEventBySyncId } from '../../protocol/eventInfo.js';
import { fetchHistoryPage, type HistoryDirection } from '../../protocol/history.js';
import { attachReplyCounts } from '../../protocol/threads.js';
import type { ToolDeps } from './deps.js';
import {
  messageIdMissing,
  messageIdOf,
  messageOutsideChat,
  type MessageInputInvalid,
  type MessageNotFound,
} from './messageFailure.js';

export interface GetMessageContextInput {
  /** Чат, тред либо ссылка xlnk на сообщение */
  chat: string;
  /** Без него адрес берётся из `sync_id` ссылки в `chat` */
  message_id?: string | undefined;
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

export type GetMessageContextResult =
  | GetMessageContextOk
  | MessageNotFound
  | MessageInputInvalid
  | ChatResolveFailure;

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

  const messageId = messageIdOf(input);
  if (messageId === undefined) {
    return messageIdMissing();
  }
  const resolved = await resolveChat(deps, input.chat);
  if (resolved.kind !== 'resolved') {
    return resolveFailure(resolved);
  }

  const lookup = await fetchEventBySyncId(deps, { chatId: resolved.chat.chat_id, syncId: messageId });
  /* Сообщение треда, адресованное родительским чатом: окно строится по истории треда */
  const chat =
    lookup.event === undefined ? resolved.chat : await containerChatOf(deps, resolved.chat, lookup.event);
  if (chat === undefined) {
    return messageOutsideChat(messageId, resolved.chat.chat_id);
  }
  const pivotMessages =
    lookup.event === undefined
      ? []
      : enrichMessages(toMessages(await decryptHistoryEvents(deps, [lookup.event])), chat);
  const beforeRaw = await readSide(deps, chat, messageId, beforeCount, 'backward');
  const afterRaw = await readSide(deps, chat, messageId, afterCount, 'forward');

  /* Один шаг счётчиков на всё окно: список тредов запрашивается не больше одного раза */
  const counted = await attachReplyCounts(deps, [
    ...beforeRaw,
    ...pivotMessages.slice(0, 1),
    ...afterRaw,
  ]);
  const before = counted.slice(0, beforeRaw.length);
  const pivotMessage = pivotMessages.length > 0 ? counted[beforeRaw.length] : undefined;
  const after = counted.slice(counted.length - afterRaw.length);

  deps.logger.debug('get_message_context: окно собрано', {
    chatId: chat.chat_id,
    before: before.length,
    after: after.length,
    pivotFound: pivotMessage !== undefined,
  });

  return {
    status: 'ok',
    chat_id: chat.chat_id,
    pivot_message_id: messageId,
    before,
    ...(pivotMessage !== undefined ? { message: pivotMessage } : {}),
    after,
  };
}
