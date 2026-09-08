/**
 * Адресация чата: строка запроса -> запись чата.
 *
 * ГАДАТЬ ЗАПРЕЩЕНО. Несколько совпадений это НЕ повод выбрать «наиболее вероятное»:
 * наружу уходят кандидаты, а выбор делает вызывающий. Путь чтения тем же резолвом
 * кормит будущую отправку, где ошибка в выборе чата означает сообщение не тому человеку,
 * и вводить догадку на чтении, чтобы потом убирать её на записи, поздно.
 *
 * АДРЕС НЕ КОНСТРУИРУЕТСЯ. Единственный источник `chat_id` это `group_chat_id` из списка
 * чатов. Никакой склейки идентификаторов участников: у Клаудс сервер выдаёт единый UUID
 * на чат любого вида, включая чат с собой, поэтому собирать адрес самому не из чего и
 * незачем.
 */
import {
  SELF_CHAT_TYPE,
  normalizeChats,
  sortChatsByFreshness,
  type ChatRecord,
} from '../protocol/chatShape.js';
import { fetchChatList, type ChatListDeps } from '../protocol/chatList.js';
import { UUID_PATTERN } from '../protocol/messageShape.js';

/**
 * Имена чата с собой. Список закрытый и на двух языках: модель адресует «Избранное» по
 * названию из интерфейса, а человек в промпте пишет «себе» или «me», и все эти строки
 * означают один и тот же чат типа `notes`.
 */
const SELF_CHAT_ALIASES = /^(избранное|заметки|notes|saved messages|себе|я|me)$/i;

/** Кандидат для выдачи наружу: адрес, имя и вид, без ключевого материала */
export interface ChatCandidate {
  chat_id: string;
  name?: string;
  kind: string;
}

export type ResolveChatResult =
  | { kind: 'resolved'; chat: ChatRecord }
  | { kind: 'ambiguous'; candidates: ChatCandidate[] }
  | { kind: 'not_found'; reason: string };

export function isChatId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function toChatCandidate(chat: ChatRecord): ChatCandidate {
  return {
    chat_id: chat.chat_id,
    ...(chat.name !== undefined ? { name: chat.name } : {}),
    kind: chat.kind,
  };
}

/** Ветка «ноль совпадений» недостижима там, где список уже отфильтрован непустым */
const NO_MATCH_REASON = 'совпадений не нашлось';

/** Один кандидат это разрешение, несколько это неоднозначность, ноль это промах */
function decide(matched: readonly ChatRecord[], reason: string): ResolveChatResult {
  const single = matched[0];
  if (matched.length === 1 && single !== undefined) {
    return { kind: 'resolved', chat: single };
  }
  if (matched.length > 1) {
    return { kind: 'ambiguous', candidates: matched.map(toChatCandidate) };
  }
  return { kind: 'not_found', reason };
}

export async function resolveChat(deps: ChatListDeps, query: string): Promise<ResolveChatResult> {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return { kind: 'not_found', reason: 'пустой запрос: адресовать чат нечем' };
  }

  const chats = sortChatsByFreshness(normalizeChats(await fetchChatList(deps)));

  if (isChatId(trimmed)) {
    const exact = chats.find((chat) => chat.chat_id.toLowerCase() === trimmed.toLowerCase());
    if (exact !== undefined) {
      return { kind: 'resolved', chat: exact };
    }
    return {
      kind: 'not_found',
      reason: `нет такого чата в списке: идентификатор ${trimmed} не встретился среди доступных чатов`,
    };
  }

  if (SELF_CHAT_ALIASES.test(trimmed)) {
    /*
     * Чат с собой заводится лениво, при первом открытии «Избранного» в клиенте (наблюдено
     * живьём), поэтому его отсутствие это штатное состояние учётной записи, а не сбой.
     */
    return decide(
      chats.filter((chat) => chat.kind === SELF_CHAT_TYPE),
      'чата с собой в списке нет: он заводится при первом открытии «Избранного» в мессенджере',
    );
  }

  const lowered = trimmed.toLowerCase();
  /*
   * Точное имя старше подстроки: чат «Дежурка» не должен становиться неоднозначным только
   * потому, что рядом живёт «Дежурка резерв».
   */
  const exactByName = chats.filter((chat) => chat.name?.toLowerCase() === lowered);
  if (exactByName.length > 0) {
    return decide(exactByName, NO_MATCH_REASON);
  }

  return decide(
    chats.filter((chat) => chat.name?.toLowerCase().includes(lowered) === true),
    `ни один чат не совпал с запросом «${trimmed}» ни точным именем, ни подстрокой`,
  );
}
