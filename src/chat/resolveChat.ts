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
 *
 * ЛИЧНЫЙ ЧАТ АДРЕСУЕТСЯ ИМЕНЕМ ЧЕЛОВЕКА. На проводе у всех личных чатов одно и то же имя,
 * поэтому перед сравнением список проходит резолв имён собеседников: без него запрос по
 * фамилии не совпал бы ни с чем, а запрос «personal chat» совпал бы со всеми сразу.
 */
import {
  SELF_CHAT_TYPE,
  normalizeChats,
  resolvePeerNames,
  sortChatsByFreshness,
  type ChatRecord,
  type PeerNamesDeps,
} from '../protocol/chatShape.js';
import { fetchChatList, type ChatListDeps } from '../protocol/chatList.js';
import { UUID_PATTERN } from '../protocol/messageShape.js';

/** Резолв ходит и за списком чатов, и за именами собеседников: без второго людей не найти */
export type ResolveChatDeps = ChatListDeps & PeerNamesDeps;

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

function isChatId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function toChatCandidate(chat: ChatRecord): ChatCandidate {
  return {
    chat_id: chat.chat_id,
    ...(chat.name !== undefined ? { name: chat.name } : {}),
    kind: chat.kind,
  };
}

/** Ветка «ноль совпадений» недостижима там, где список уже отфильтрован непустым */
const NO_MATCH_REASON = 'совпадений не нашлось';

/** Слова строки без пустых: разделителями считаются пробелы и запятые */
function wordsOf(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[\s,]+/)
    .filter((word) => word.length > 0);
}

/** Все слова запроса встречаются в имени, порядок при этом не важен */
function containsAllWords(name: string | undefined, queryWords: readonly string[]): boolean {
  if (name === undefined || queryWords.length === 0) {
    return false;
  }
  const nameWords = new Set(wordsOf(name));
  return queryWords.every((word) => nameWords.has(word));
}

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

export async function resolveChat(deps: ResolveChatDeps, query: string): Promise<ResolveChatResult> {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return { kind: 'not_found', reason: 'пустой запрос: адресовать чат нечем' };
  }

  const chats = await resolvePeerNames(
    deps,
    sortChatsByFreshness(normalizeChats(await fetchChatList(deps))),
  );

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
  const queryWords = wordsOf(trimmed);
  /*
   * Точное имя старше подстроки: чат «Дежурка» не должен становиться неоднозначным только
   * потому, что рядом живёт «Дежурка резерв».
   */
  const exactByName = chats.filter((chat) => chat.name?.toLowerCase() === lowered);
  if (exactByName.length > 0) {
    return decide(exactByName, NO_MATCH_REASON);
  }

  const bySubstring = chats.filter((chat) => chat.name?.toLowerCase().includes(lowered) === true);
  if (bySubstring.length > 0) {
    return decide(bySubstring, NO_MATCH_REASON);
  }

  /*
   * Последняя попытка: сравнение по множеству слов. Человека называют и «Фамилия Имя», и
   * «Имя Фамилия», а в справке имя записано одним порядком, и подстрока второй порядок не
   * ловит. Отчество при этом мешать не должно, поэтому слова запроса обязаны входить в
   * имя, а не совпадать с ним целиком.
   */
  return decide(
    chats.filter((chat) => containsAllWords(chat.name, queryWords)),
    `ни один чат не совпал с запросом «${trimmed}» ни точным именем, ни подстрокой, ни набором слов`,
  );
}
