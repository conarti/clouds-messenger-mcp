/**
 * Разбор просьбы сервера подождать.
 *
 * Проверяется не «сколько именно», а то, ради чего модуль написан: при ЛЮБОЙ гипотезе
 * о единице измерения пауза остаётся в диапазоне от секунды до минуты, а сырое значение
 * и выбранная трактовка уезжают в лог, чтобы первое живое срабатывание сняло неизвестность.
 */
import { describe, expect, it } from 'vitest';
import type { LogFields, Logger } from '../../src/util/logger.js';
import {
  DEFAULT_PAUSE_MS,
  MAX_PAUSE_MS,
  MIN_PAUSE_MS,
  isRateLimitCode,
  readRetryAfterField,
  resolvePauseMs,
} from '../../src/transport/rateLimit.js';

interface Recorded {
  message: string;
  fields: Record<string, unknown>;
}

/** Логгер-накопитель: настоящий писал бы в stderr прогона и ничего не доказывал бы */
function recordingLogger(): { logger: Logger; records: Recorded[] } {
  const records: Recorded[] = [];
  const push = (message: string, fields?: LogFields): void => {
    records.push({ message, fields: (fields ?? {}) as Record<string, unknown> });
  };
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: push,
    error: () => undefined,
    child: () => logger,
  };
  return { logger, records };
}

describe('resolvePauseMs: трактовка по величине', () => {
  it('малое число читается как секунды', () => {
    expect(resolvePauseMs(5)).toBe(5_000);
  });

  it('большое число читается как миллисекунды', () => {
    expect(resolvePauseMs(2_500)).toBe(2_500);
  });

  it('строка с числом разбирается так же, как число', () => {
    expect(resolvePauseMs('5')).toBe(5_000);
    expect(resolvePauseMs(' 2500 ')).toBe(2_500);
  });

  /* Дата не оставляет места догадкам про единицу: разность это миллисекунды по определению */
  it('HTTP-дата превращается в остаток до срока', () => {
    const deadline = new Date(Date.now() + 5_000).toUTCString();

    const pauseMs = resolvePauseMs(deadline);

    expect(pauseMs).toBeGreaterThanOrEqual(4_000);
    expect(pauseMs).toBeLessThanOrEqual(6_000);
  });

  it('прошедшая HTTP-дата даёт минимальную паузу, а не ноль', () => {
    expect(resolvePauseMs(new Date(Date.now() - 60_000).toUTCString())).toBe(MIN_PAUSE_MS);
  });
});

describe('resolvePauseMs: зажим', () => {
  it('пауза короче секунды поднимается до нижней границы', () => {
    expect(resolvePauseMs(0)).toBe(MIN_PAUSE_MS);
    expect(resolvePauseMs(0.25)).toBe(MIN_PAUSE_MS);
  });

  it('пауза длиннее минуты срезается до верхней границы', () => {
    expect(resolvePauseMs(600)).toBe(MAX_PAUSE_MS);
    expect(resolvePauseMs(3_600_000)).toBe(MAX_PAUSE_MS);
  });

  it('рабочий диапазон проходит как есть', () => {
    expect(resolvePauseMs(30_000)).toBe(30_000);
    expect(resolvePauseMs(MIN_PAUSE_MS)).toBe(MIN_PAUSE_MS);
    expect(resolvePauseMs(MAX_PAUSE_MS)).toBe(MAX_PAUSE_MS);
  });
});

describe('resolvePauseMs: мусор', () => {
  /* Сервер о паузе попросил: разобрать просьбу и выбросить хуже, чем подождать минимум */
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['не число в строке', 'скоро'],
    ['пустая строка', '   '],
    ['отрицательное', -5],
    ['NaN', Number.NaN],
    ['бесконечность', Number.POSITIVE_INFINITY],
    ['объект', { wait: 5 }],
    ['булево', true],
  ])('%s даёт паузу по умолчанию', (_name, raw) => {
    expect(resolvePauseMs(raw)).toBe(DEFAULT_PAUSE_MS);
  });
});

describe('resolvePauseMs: лог', () => {
  it('пишет предупреждение с сырым значением, трактовкой и фактом зажима', () => {
    const { logger, records } = recordingLogger();

    resolvePauseMs(600, logger);

    expect(records).toHaveLength(1);
    expect(records[0]?.fields).toMatchObject({
      rawPause: 600,
      interpretation: 'seconds',
      clamp: 'max',
      pauseMs: MAX_PAUSE_MS,
    });
  });

  it('называет мусорное значение мусорным, а не прячет его', () => {
    const { logger, records } = recordingLogger();

    resolvePauseMs('скоро', logger);

    expect(records[0]?.fields).toMatchObject({ rawPause: 'скоро', interpretation: 'invalid' });
  });

  it('различает миллисекунды и дату в трактовке', () => {
    const { logger, records } = recordingLogger();

    resolvePauseMs(2_500, logger);
    resolvePauseMs(new Date(Date.now() + 5_000).toUTCString(), logger);

    expect(records[0]?.fields['interpretation']).toBe('milliseconds');
    expect(records[1]?.fields['interpretation']).toBe('http-date');
  });
});

describe('признаки лимита', () => {
  it('узнаёт коды лимита и не путает их с прочими отказами', () => {
    expect(isRateLimitCode('rate_limited')).toBe(true);
    expect(isRateLimitCode('too_many_requests')).toBe(true);
    expect(isRateLimitCode('invalid_keys')).toBe(false);
    expect(isRateLimitCode(undefined)).toBe(false);
  });

  it('достаёт величину паузы из тела отказа и молчит, когда её нет', () => {
    expect(readRetryAfterField({ error: 'rate_limited', retry_after: 3 })).toBe(3);
    expect(readRetryAfterField({ error: 'rate_limited' })).toBeUndefined();
    expect(readRetryAfterField(null)).toBeUndefined();
    expect(readRetryAfterField('строка')).toBeUndefined();
  });
});
