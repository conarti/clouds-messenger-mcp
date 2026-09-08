/**
 * Реакции: разбор компактной строки счётчиков и списка своих реакций.
 *
 * РЕАКЦИЯ ЭТО САМ ЭМОДЗИ. Не числовой идентификатор артворка, как это было у Яндекса, а
 * unicode-строка (наблюдено живьём, findings.md, P5). Поэтому карты перевода нет и
 * переводить нечего: что приехало в счётчике, то и уходит наружу.
 *
 * ФОРМА НАБЛЮДЕНА ЖИВЬЁМ: `meta.activities.reaction_counters` это ОДНА строка вида
 * `эмодзи:счётчик`, записи разделены запятой (живой образец `"✅:1"`), а свои реакции
 * лежат отдельно в `meta.activities.user_reactions.emoji`. Метки неподтверждённости у
 * этой формы нет и быть не должно.
 *
 * РАЗДЕЛИТЕЛЬ ИЩЕТСЯ С КОНЦА записи. Сам эмодзи двоеточия не содержит, а вот составная
 * последовательность эмодзи содержит что угодно, и поиск с начала откусил бы половину
 * символа, оставив в выдаче обломок вместо реакции.
 */
import { asObject, stringOr } from '../util/json.js';

/** Пара «эмодзи и его счётчик» без знания о том, чья это реакция */
export interface ReactionCount {
  emoji: string;
  count: number;
}

/**
 * Реакция в выдаче. `mine` отвечает на единственный вопрос, ради которого список читают
 * повторно: поставил ли я её сам.
 */
export interface Reaction extends ReactionCount {
  mine: boolean;
}

/**
 * Компактная строка счётчиков в пары.
 *
 * Мусорная запись выбрасывается поштучно, а не роняет разбор: одна нечитаемая пара не
 * повод потерять остальные реакции сообщения.
 */
export function parseReactionCounters(counters: string): ReactionCount[] {
  return counters.split(',').flatMap((part) => {
    const separator = part.lastIndexOf(':');
    if (separator <= 0) {
      return [];
    }
    const emoji = part.slice(0, separator).trim();
    const count = Number.parseInt(part.slice(separator + 1).trim(), 10);
    if (emoji.length === 0 || Number.isNaN(count)) {
      return [];
    }
    return [{ emoji, count }];
  });
}

/** Свои реакции: массив строк-эмодзи. Всё, что не строка, пропускается */
export function parseUserReactions(raw: unknown): string[] {
  const emoji = asObject(raw)?.['emoji'];
  return (Array.isArray(emoji) ? emoji : []).flatMap((entry) => {
    const value = stringOr(entry);
    return value === undefined ? [] : [value];
  });
}

/**
 * Реакции ВНЕШНЕГО события: они живут в `meta.activities`, а не во внутреннем событии,
 * поэтому читаются без расшифровки.
 *
 * Пустой массив означает «реакций нет», и это не то же самое, что отсутствие поля: выше
 * по стеку форма сообщения сама решает, добавлять ли ключ, а инструмент реакций отдаёт
 * пустой список честно.
 */
export function extractReactions(rawEvent: Record<string, unknown> | undefined): Reaction[] {
  const activities = asObject(asObject(rawEvent?.['meta'])?.['activities']);
  const counters = stringOr(activities?.['reaction_counters']);
  if (counters === undefined) {
    return [];
  }
  const mine = new Set(parseUserReactions(activities?.['user_reactions']));
  return parseReactionCounters(counters).map((entry) => ({ ...entry, mine: mine.has(entry.emoji) }));
}
