/**
 * Опросы: признак опроса в сообщении и сырые поля опроса.
 *
 * ЖИВЬЁМ ОПРОС НЕ НАБЛЮДАЛСЯ (findings.md, P3): опрос нельзя завести в личном чате, а
 * полигон это чат с собой, поэтому вся форма ниже взята из бандла веб-клиента.
 *
 * ОТДЕЛЬНОЙ РУЧКИ ЧТЕНИЯ ОПРОСА НЕТ. В бандле у опросов есть создание, голосование, отзыв
 * голоса, завершение и список проголосовавших, но НЕ чтение: сам опрос (вопрос, варианты,
 * настройки, автор) приезжает ВНУТРИ сообщения, а изменения счётчиков прилетают отдельными
 * событиями сокета. Поэтому чтение опроса это чтение сообщения, а не REST-запрос: выдумывать
 * несуществующий адрес ради красивой архитектуры нельзя.
 *
 * НОРМАЛИЗАЦИИ НЕТ НАМЕРЕННО. Наружу уходят СЫРЫЕ поля: раскладывать по своим именам форму,
 * которую никто не видел живьём, значит закрепить догадку и потерять всё, что в неё не
 * попало. Единственное, что разбирается, это адрес опроса, потому что им адресуется
 * будущее голосование.
 */
import { asObject, stringOr } from '../util/json.js';

/** Значение `type` внутреннего события опроса (из бандла) */
const POLL_INNER_TYPE = 'poll';

/**
 * Виды чатов, где опроса не может быть в принципе: опрос это функция ГРУППОВОГО чата
 * (findings.md, P3). Список закрытый, потому что оба значения наблюдены живьём в списке
 * чатов, а всё остальное считается способным нести опрос.
 */
const CHAT_KINDS_WITHOUT_POLLS = new Set(['notes', 'chat']);

export function supportsPolls(chatKind: string): boolean {
  return !CHAT_KINDS_WITHOUT_POLLS.has(chatKind);
}

export interface PollReference {
  /** `poll_id`: собственный адрес опроса, НЕ `sync_id` сообщения (различие из бандла) */
  poll_id?: string;
  /** Поля опроса как они приехали */
  raw: Record<string, unknown>;
}

/**
 * Опрос из внутреннего события. `undefined` означает «это не опрос».
 *
 * Признаков два, и они равноправны: тип события и наличие собственного адреса опроса в
 * нагрузке. Один признак был бы уже, чем знание: тип взят из перечисления бандла, а имя
 * поля адреса из схемы валидации того же бандла, и какой из них приедет живьём, не проверено.
 */
export function extractPoll(inner: Record<string, unknown> | undefined): PollReference | undefined {
  if (inner === undefined) {
    return undefined;
  }
  const payload = asObject(inner['payload']);
  const pollId = stringOr(payload?.['poll_id']) ?? stringOr(inner['poll_id']);
  if (stringOr(inner['type']) !== POLL_INNER_TYPE && pollId === undefined) {
    return undefined;
  }
  return {
    ...(pollId !== undefined ? { poll_id: pollId } : {}),
    /* Нагрузка, если она есть; иначе внутреннее событие целиком, чтобы не потерять поля */
    raw: payload ?? inner,
  };
}

/**
 * Свои голоса из `meta.activities.user_reactions.votes`.
 *
 * Имя поля наблюдено живьём рядом со своими реакциями, а вот форма ЭЛЕМЕНТА не наблюдалась
 * ни разу: в живой пробе массив был пуст. Поэтому элементы уходят наружу как есть, без
 * попытки привести их к строке: приведение выбросило бы всё, что окажется объектом.
 */
export function extractMyVotes(rawEvent: Record<string, unknown> | undefined): unknown[] {
  const activities = asObject(asObject(rawEvent?.['meta'])?.['activities']);
  const votes = asObject(activities?.['user_reactions'])?.['votes'];
  return Array.isArray(votes) ? votes : [];
}
