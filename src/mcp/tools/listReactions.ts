/**
 * `list_reactions`: реакции одного сообщения полным списком.
 *
 * РЕАКЦИИ ЧИТАЮТСЯ БЕЗ РАСШИФРОВКИ. Они живут в `meta.activities` ВНЕШНЕГО события, а не в
 * зашифрованном теле, поэтому нечитаемое тело не мешает отдать реакции: сообщение может не
 * расшифроваться, а список тех, кто на него отреагировал, при этом остаётся верным.
 *
 * РЕАКЦИЯ ЭТО ЭМОДЗИ. Никаких числовых идентификаторов артворка, как это было у Яндекса:
 * что пришло в счётчике, то и уходит наружу, и обратный перевод вызывающему не нужен.
 *
 * МЕТКИ НЕПОДТВЕРЖДЁННОСТИ БОЛЬШЕ НЕТ. И форма реакций (`reaction_counters` строкой, свои
 * реакции отдельным списком), и оба пути чтения события наблюдены живьём: адресное чтение
 * прошло живой пробой на полигоне, запасной проход по истории тоже.
 */
import { resolveChat } from '../../chat/resolveChat.js';
import { resolveFailure, type ChatResolveFailure } from '../../chat/resolveFailure.js';
import { fetchEventBySyncId } from '../../protocol/eventInfo.js';
import { extractReactions, type Reaction } from '../../protocol/reactions.js';
import { messageNotFound, type MessageNotFound } from './messageFailure.js';
import type { ToolDeps } from './deps.js';

export interface ListReactionsInput {
  chat: string;
  message_id: string;
}

export interface ListReactionsOk {
  status: 'ok';
  chat_id: string;
  message_id: string;
  reactions: Reaction[];
  /** Сумма счётчиков: сколько всего реакций стоит на сообщении */
  total: number;
}

export type ListReactionsResult = ListReactionsOk | MessageNotFound | ChatResolveFailure;

export async function listReactions(
  deps: ToolDeps,
  input: ListReactionsInput,
): Promise<ListReactionsResult> {
  const resolved = await resolveChat(deps, input.chat);
  if (resolved.kind !== 'resolved') {
    return resolveFailure(resolved);
  }
  const chat = resolved.chat;

  const lookup = await fetchEventBySyncId(deps, { chatId: chat.chat_id, syncId: input.message_id });
  if (lookup.event === undefined) {
    return messageNotFound(`в чате ${chat.chat_id} нет события с sync_id ${input.message_id}`);
  }

  const reactions = extractReactions(lookup.event);
  const total = reactions.reduce((sum, reaction) => sum + reaction.count, 0);

  deps.logger.debug('list_reactions: реакции собраны', {
    chatId: chat.chat_id,
    kinds: reactions.length,
    total,
  });

  return { status: 'ok', chat_id: chat.chat_id, message_id: input.message_id, reactions, total };
}
