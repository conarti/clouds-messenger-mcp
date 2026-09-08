/**
 * Единая форма отказа адресации.
 *
 * ОДНО МЕСТО НА ВСЕ ИНСТРУМЕНТЫ. Форма отказа, объявленная в каждом инструменте отдельно,
 * расходится на первой же правке, и вызывающий вынужден различать инструменты по форме
 * тела вместо одного поля. Здесь и тип, и сборка, а согласованность держит компилятор.
 *
 * ДИСКРИМИНАТОР БЕЗ ИНСТРУКЦИИ НЕМ. К машинному `status` обязателен человеческий
 * `next_step`: агент понимает, ЧТО случилось, но без подсказки не понимает, чем это чинить.
 */
import type { ChatCandidate, ResolveChatResult } from './resolveChat.js';

export interface AmbiguousChatFailure {
  status: 'ambiguous_chat';
  candidates: ChatCandidate[];
  next_step: string;
}

export interface ChatNotFoundFailure {
  status: 'chat_not_found';
  reason: string;
  next_step: string;
}

export type ChatResolveFailure = AmbiguousChatFailure | ChatNotFoundFailure;

/** Исходы адресации, кроме успешного: только они превращаются в отказ */
export type UnresolvedChat = Exclude<ResolveChatResult, { kind: 'resolved' }>;

const AMBIGUOUS_NEXT_STEP =
  'запрос совпал с несколькими чатами, выбор за вами: повторите вызов, передав в chat ' +
  'идентификатор chat_id одного из candidates';

const NOT_FOUND_NEXT_STEP =
  'уточните запрос либо возьмите chat_id из выдачи list_chats и передайте его в chat';

export function resolveFailure(unresolved: UnresolvedChat): ChatResolveFailure {
  if (unresolved.kind === 'ambiguous') {
    return {
      status: 'ambiguous_chat',
      candidates: unresolved.candidates,
      next_step: AMBIGUOUS_NEXT_STEP,
    };
  }
  return {
    status: 'chat_not_found',
    reason: unresolved.reason,
    next_step: NOT_FOUND_NEXT_STEP,
  };
}
