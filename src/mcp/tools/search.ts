/**
 * `search`: поиск чатов по имени и людей по контактам.
 *
 * ИЩЕТ ПО СПИСКУ ЧАТОВ, А НЕ НА СЕРВЕРЕ. Серверной ручки поиска у Клаудс не снято ни
 * живой пробой, ни с бандла веб-клиента, поэтому единственный честный источник это тот же
 * список чатов, которым живёт `list_chats`. Выдумывать несуществующий запрос к серверу
 * ради красивой формы инструмента нельзя: он молча вернул бы отказ на первом же вызове.
 *
 * ПО ТЕКСТАМ СООБЩЕНИЙ ПОИСКА НЕТ, И ЭТО ГОВОРИТСЯ ВСЛУХ. Запрос `entities: ['messages']`
 * не возвращает пустой успех: пустая выдача читается агентом как факт «ничего не найдено»,
 * то есть как утверждение о переписке, которого никто не проверял. Вместо неё уезжает
 * `escalation` с причиной и следующим шагом, и агент уходит в `get_history` с датами.
 *
 * ЦЕНА ВЫЗОВА. Один кадр за список чатов; ещё один за счётчики непрочитанного, но только
 * когда спрошены чаты. Счётчик не подставляется нулём «за неимением»: ноль в поле
 * непрочитанного это утверждение «всё прочитано», а не признание незнания.
 */
import { z } from 'zod';
import { DEFAULT_LIMITS } from '../../config/defaults.js';
import { fetchChatList, fetchUnreadCounters, type ChatListDeps } from '../../protocol/chatList.js';
import {
  normalizeChats,
  sortChatsByFreshness,
  toPublicChat,
  type Chat,
  type ChatRecord,
} from '../../protocol/chatShape.js';
import { matchesChatName, toContactHit, type ContactHit } from '../../protocol/search.js';

/** Что искать. Значения перечислены здесь же, потому что схема инструмента их и объявляет */
export type SearchEntity = 'users' | 'chats' | 'messages';

/** `| undefined` в полях осознанно: под exactOptionalPropertyTypes zod отдаёт именно такой тип */
export interface SearchInput {
  query: string;
  entities?: SearchEntity[] | undefined;
  limit?: number | undefined;
}

/** Отказ платформы вместе с тем, чем его обойти: дискриминатор без инструкции нем */
export interface SearchEscalation {
  reason: string;
  next_step: string;
}

export interface SearchResult {
  status: 'ok';
  /** Запрос как его прислали: выдача часто едет дальше отдельно от вызова */
  query: string;
  chats?: Chat[];
  users?: ContactHit[];
  escalation?: SearchEscalation;
  /** Хоть одна из выдач упёрлась в limit: набор неполон, и это видно, а не угадывается */
  truncated: boolean;
  partial?: boolean;
  partial_reason?: string;
}

/**
 * Дефолт сущностей. Сообщений тут нет намеренно: поиска по текстам платформа не даёт, и
 * добавлять в дефолт заведомую эскалацию значило бы отвечать отказом на каждый вызов.
 */
const DEFAULT_ENTITIES: readonly SearchEntity[] = ['users', 'chats'];

const MESSAGES_ESCALATION: SearchEscalation = {
  reason: 'поиск по текстам сообщений не поддерживается платформенно',
  next_step:
    'выберите чат через search entities chats или list_chats и читайте get_history с фильтрами дат',
};

const CONTACTS_PARTIAL_REASON =
  'поиск людей идёт только по контактам с существующим личным чатом; серверный справочник ' +
  'не подключён';

/**
 * Зависимости сужены до списка чатов: этот инструмент не расшифровывает и не ходит в REST.
 * Полный набор зависимостей сервера сюда подходит по построению, а проверке не приходится
 * собирать крипто и авторизацию ради поиска по именам.
 */
export type SearchDeps = ChatListDeps;

/** Определение для регистрации: сервер передаёт его вторым аргументом в registerTool */
export const SEARCH_TOOL_DEFINITION = {
  title: 'Search chats and contacts',
  description:
    'Поиск чатов по имени и людей по контактам, у которых уже есть личный чат. Ищет ПО СПИСКУ ' +
    'ЧАТОВ: серверного справочника людей у платформы не снято, поэтому выдача людей помечается ' +
    'partial. Поиска по текстам сообщений НЕТ: запрос messages возвращает escalation со ' +
    'следующим шагом, а не пустую выдачу. Стоит один вызов к серверу, а с чатами два.',
  inputSchema: {
    query: z
      .string()
      .min(1)
      .describe('Подстрока имени чата либо имени собеседника; регистр не важен'),
    entities: z
      .array(z.enum(['users', 'chats', 'messages']))
      .optional()
      .describe(
        `Что искать (по умолчанию ${[...DEFAULT_ENTITIES].join(' и ')}). Значение messages ` +
          'платформой не поддерживается и возвращает escalation',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe(
        `Максимум записей в КАЖДОЙ выдаче (по умолчанию ${DEFAULT_LIMITS.searchDefaultLimit})`,
      ),
  },
  annotations: { readOnlyHint: true },
};

/**
 * Чаты, совпавшие с запросом, свежие первыми.
 *
 * Пустой запрос не совпадает ни с чем, хотя пустая подстрока входит в любую строку: выдать
 * на пустом запросе весь список значит выдать `list_chats` за результат поиска.
 */
async function matchingChats(deps: SearchDeps, loweredQuery: string): Promise<ChatRecord[]> {
  if (loweredQuery.length === 0) {
    return [];
  }
  const records = sortChatsByFreshness(normalizeChats(await fetchChatList(deps)));
  return records.filter((chat) => matchesChatName(chat, loweredQuery));
}

export async function search(deps: SearchDeps, input: SearchInput): Promise<SearchResult> {
  const entities = input.entities ?? DEFAULT_ENTITIES;
  const limit = input.limit ?? deps.config.limits.searchDefaultLimit;
  const wantsChats = entities.includes('chats');
  const wantsUsers = entities.includes('users');
  const escalation = entities.includes('messages') ? MESSAGES_ESCALATION : undefined;

  const matched =
    wantsChats || wantsUsers ? await matchingChats(deps, input.query.trim().toLowerCase()) : [];

  let truncated = false;

  let users: ContactHit[] | undefined;
  if (wantsUsers) {
    const contacts = matched.flatMap((chat) => {
      const contact = toContactHit(chat);
      return contact === undefined ? [] : [contact];
    });
    users = contacts.slice(0, limit);
    truncated = truncated || contacts.length > limit;
  }

  let chats: Chat[] | undefined;
  if (wantsChats) {
    const page = matched.slice(0, limit);
    truncated = truncated || matched.length > limit;
    /* Счётчики спрашиваются только на страницу выдачи: за пределами среза они некуда лечь */
    const counters = await fetchUnreadCounters(
      deps,
      page.map((chat) => chat.chat_id),
    );
    chats = page.map((chat) => toPublicChat(chat, counters.get(chat.chat_id) ?? 0));
  }

  deps.logger.debug('search: выдача собрана', {
    entities: [...entities],
    matched: matched.length,
    chats: chats?.length ?? 0,
    users: users?.length ?? 0,
    truncated,
    escalated: escalation !== undefined,
  });

  return {
    status: 'ok',
    query: input.query,
    ...(chats !== undefined ? { chats } : {}),
    ...(users !== undefined ? { users } : {}),
    ...(escalation !== undefined ? { escalation } : {}),
    truncated,
    /* Пометка неполноты висит на способе, а не на числе находок: ноль контактов неполон так же */
    ...(users !== undefined ? { partial: true, partial_reason: CONTACTS_PARTIAL_REASON } : {}),
  };
}
