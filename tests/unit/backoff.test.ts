import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_DELAY_MS,
  exponentialDelayMs,
  sleep,
} from '../../src/transport/backoff.js';

describe('exponentialDelayMs', () => {
  it('удваивает паузу от попытки к попытке', () => {
    expect(exponentialDelayMs(1, { baseDelayMs: 500 })).toBe(500);
    expect(exponentialDelayMs(2, { baseDelayMs: 500 })).toBe(1_000);
    expect(exponentialDelayMs(3, { baseDelayMs: 500 })).toBe(2_000);
  });

  it('упирается в потолок, а не растёт без границ', () => {
    expect(exponentialDelayMs(99, { baseDelayMs: 500, maxDelayMs: 8_000 })).toBe(8_000);
  });

  it('без настроек берёт значения по умолчанию', () => {
    expect(exponentialDelayMs(1)).toBe(DEFAULT_BASE_DELAY_MS);
    expect(exponentialDelayMs(99)).toBe(DEFAULT_MAX_DELAY_MS);
  });

  /* Нулевая и отрицательная попытка это ошибка вызывающего, но пауза обязана остаться базовой */
  it('нулевая попытка не даёт паузу меньше базовой', () => {
    expect(exponentialDelayMs(0, { baseDelayMs: 500 })).toBe(500);
    expect(exponentialDelayMs(-5, { baseDelayMs: 500 })).toBe(500);
  });

  it('детерминирована: джиттера нет', () => {
    const values = Array.from({ length: 20 }, () => exponentialDelayMs(3, { baseDelayMs: 100 }));

    expect(new Set(values).size).toBe(1);
  });
});

describe('sleep', () => {
  it('ждёт не меньше запрошенного', async () => {
    const started = Date.now();

    await sleep(20);

    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });
});
