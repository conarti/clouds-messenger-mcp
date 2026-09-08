/**
 * Разбор реакций.
 *
 * ГЛАВНОЕ, ЧТО ЗДЕСЬ ДОКАЗЫВАЕТСЯ: реакция это ЭМОДЗИ-СТРОКА, а не числовой идентификатор
 * артворка. Это отличие от Яндекса, и оно проверяется явно: как только в выдаче появится
 * число, вместе с ним появится и карта перевода, которой в этом протоколе нет.
 *
 * Компактная строка счётчиков разбирается с конца записи, потому что составная
 * последовательность эмодзи может содержать что угодно, кроме гарантий.
 */
import { describe, expect, it } from 'vitest';
import {
  extractReactions,
  parseReactionCounters,
  parseUserReactions,
} from '../../src/protocol/reactions.js';

/** Внешнее событие ровно в той форме, в какой активности приезжают живьём */
function eventWithActivities(counters: string, mine: string[]): Record<string, unknown> {
  return {
    sync_id: '00000000-0000-4000-8000-000000000001',
    meta: {
      activities: {
        reaction_counters: counters,
        user_reactions: { emoji: mine, votes: [] },
      },
    },
  };
}

describe('parseReactionCounters', () => {
  it('разбирает живой образец строки счётчиков', () => {
    expect(parseReactionCounters('✅:1')).toEqual([{ emoji: '✅', count: 1 }]);
  });

  it('разбирает несколько записей и не тащит пробелы в эмодзи', () => {
    expect(parseReactionCounters('✅:1, 👍:3')).toEqual([
      { emoji: '✅', count: 1 },
      { emoji: '👍', count: 3 },
    ]);
  });

  it('пустая строка, мусор и запись без эмодзи дают пустой список', () => {
    expect(parseReactionCounters('')).toEqual([]);
    expect(parseReactionCounters('совсем не счётчик')).toEqual([]);
    expect(parseReactionCounters(':5')).toEqual([]);
    expect(parseReactionCounters('✅:не число')).toEqual([]);
  });

  it('мусорная запись выбрасывается поштучно, соседние реакции выживают', () => {
    expect(parseReactionCounters('✅:1, сломано, 👍:2,')).toEqual([
      { emoji: '✅', count: 1 },
      { emoji: '👍', count: 2 },
    ]);
  });

  it('разделитель ищется с конца: двоеточие внутри метки не откусывает половину', () => {
    expect(parseReactionCounters('a:b:7')).toEqual([{ emoji: 'a:b', count: 7 }]);
  });

  it('составная последовательность эмодзи остаётся целой', () => {
    expect(parseReactionCounters('👨‍👩‍👧:2')).toEqual([{ emoji: '👨‍👩‍👧', count: 2 }]);
  });
});

describe('parseUserReactions', () => {
  it('берёт свои реакции из поля emoji', () => {
    expect(parseUserReactions({ emoji: ['✅', '👍'], votes: [] })).toEqual(['✅', '👍']);
  });

  it('пустое и неожиданное значение дают пустой список, а не падение', () => {
    expect(parseUserReactions(undefined)).toEqual([]);
    expect(parseUserReactions({ votes: [] })).toEqual([]);
    expect(parseUserReactions({ emoji: 'не массив' })).toEqual([]);
    expect(parseUserReactions({ emoji: [42, null, '✅'] })).toEqual(['✅']);
  });
});

describe('extractReactions', () => {
  it('собирает счётчики и отмечает свои реакции', () => {
    expect(extractReactions(eventWithActivities('✅:1, 👍:3', ['👍']))).toEqual([
      { emoji: '✅', count: 1, mine: false },
      { emoji: '👍', count: 3, mine: true },
    ]);
  });

  it('событие без активностей это ноль реакций, а не отказ разбора', () => {
    expect(extractReactions({ sync_id: 'x' })).toEqual([]);
    expect(extractReactions(undefined)).toEqual([]);
    expect(extractReactions({ meta: { activities: {} } })).toEqual([]);
  });

  it('реакция это эмодзи-строка, а не числовой идентификатор артворка', () => {
    const reactions = extractReactions(eventWithActivities('✅:1, 👍:3', ['✅']));

    expect(reactions).toHaveLength(2);
    for (const reaction of reactions) {
      expect(typeof reaction.emoji).toBe('string');
      /* Число в этом поле означало бы чужой протокол и карту перевода, которой здесь нет */
      expect(Number.isNaN(Number(reaction.emoji))).toBe(true);
    }
  });
});
