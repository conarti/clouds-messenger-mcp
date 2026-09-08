/**
 * Признак опроса и его сырые поля.
 *
 * ВСЯ ФОРМА ЗДЕСЬ НЕПОДТВЕРЖДЁННАЯ, и проверка это фиксирует, а не прячет: опрос нельзя
 * завести в чате с собой, поэтому живой пробы у него нет (findings.md, P3), а признаки
 * взяты из бандла веб-клиента. Проверяется ровно то, что заявлено: два равноправных
 * признака, отсутствие нормализации и разделение «не опрос» и «опросов тут не бывает».
 */
import { describe, expect, it } from 'vitest';
import { extractMyVotes, extractPoll, supportsPolls } from '../../src/protocol/poll.js';
import { MY_HUID, POLYGON_CHAT_ID, makeInnerText } from '../helpers/readFixtures.js';

describe('supportsPolls', () => {
  it('опрос это функция группового чата', () => {
    expect(supportsPolls('group_chat')).toBe(true);
    expect(supportsPolls('channel')).toBe(true);
  });

  it('в заметках и в личном чате опроса быть не может', () => {
    expect(supportsPolls('notes')).toBe(false);
    expect(supportsPolls('chat')).toBe(false);
  });
});

describe('extractPoll', () => {
  it('признаёт опрос по типу события и отдаёт нагрузку без нормализации', () => {
    const inner = {
      type: 'poll',
      payload: { poll_id: 'poll-1', question: 'кто дежурит', variants: [{ id: 'v1' }] },
    };

    expect(extractPoll(inner)).toEqual({
      poll_id: 'poll-1',
      raw: { poll_id: 'poll-1', question: 'кто дежурит', variants: [{ id: 'v1' }] },
    });
  });

  it('признаёт опрос по собственному адресу, даже если тип приехал другим', () => {
    const found = extractPoll({ type: 'тип из будущего', payload: { poll_id: 'poll-2' } });

    expect(found?.poll_id).toBe('poll-2');
  });

  it('событие с типом опроса, но без нагрузки отдаётся целиком: поля не теряются', () => {
    expect(extractPoll({ type: 'poll', question: 'без нагрузки' })).toEqual({
      raw: { type: 'poll', question: 'без нагрузки' },
    });
  });

  it('обычное сообщение опросом не считается', () => {
    const text = makeInnerText({
      msgId: '00000000-0000-4000-8000-000000000001',
      from: MY_HUID,
      timestamp: '2026-09-08T07:01:00.000Z',
      groupChatId: POLYGON_CHAT_ID,
      body: 'опрос: кто дежурит?',
    });

    expect(extractPoll(text)).toBeUndefined();
    expect(extractPoll(undefined)).toBeUndefined();
  });
});

describe('extractMyVotes', () => {
  it('берёт голоса из активностей события как есть', () => {
    const event = {
      meta: { activities: { user_reactions: { emoji: ['✅'], votes: ['variant-1'] } } },
    };

    expect(extractMyVotes(event)).toEqual(['variant-1']);
  });

  it('пустые активности дают пустой список, а не отказ', () => {
    expect(extractMyVotes(undefined)).toEqual([]);
    expect(extractMyVotes({ meta: { activities: { user_reactions: { emoji: [], votes: [] } } } })).toEqual(
      [],
    );
    expect(extractMyVotes({ sync_id: 'x' })).toEqual([]);
  });
});
