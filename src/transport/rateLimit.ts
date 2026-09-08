/**
 * Пауза по просьбе сервера: `Retry-After` у REST и `retry_after` в отказе Phoenix.
 *
 * ==================================================================================
 *  ЕДИНИЦА ИЗМЕРЕНИЯ ПАУЗЫ НЕ УСТАНОВЛЕНА. ЗДЕСЬ ОНА НЕ УГАДЫВАЕТСЯ.
 * ==================================================================================
 * Живьём поле не приходило ни разу (Фаза 0): известно только имя, без суффикса единицы.
 * HTTP-стандарт для `Retry-After` называет секунды, но сервер этого мессенджера уже
 * показал собственную трактовку общих имён, и слепо довериться стандарту значит поставить
 * весь клиент на непроверенное допущение.
 *
 * Цена промаха плоха в обе стороны:
 *  - принять секунды за миллисекунды: `5` даст паузу в 5мс, то есть повтор-шторм ровно
 *    в тот сервер, который только что попросил притормозить;
 *  - принять миллисекунды за секунды: `30000` даст паузу в 8 часов, то есть клиент,
 *    неотличимый от зависшего.
 *
 * РЕШЕНИЕ: трактовка выбирается по величине, а результат зажимается с обеих сторон.
 * Значение меньше секунды в миллисекундах бессмысленно как просьба подождать, поэтому оно
 * читается как секунды; всё остальное как миллисекунды. Зажим в [1с, 60с] делает промах
 * по единице переживаемым при любой из гипотез: пауза не схлопнется в шторм и не превратится
 * в зависание. Точность принесена в жертву осознанно: без живого наблюдения её всё равно нет.
 *
 * Каждое применение логируется предупреждением с СЫРЫМ значением и выбранной трактовкой:
 * первое же срабатывание на живом сервере даст возможность определить единицу и снять оговорку.
 */
import type { Logger } from '../util/logger.js';

/** Нижняя граница: страховка от гипотезы «сервер прислал секунды» */
export const MIN_PAUSE_MS = 1_000;
/** Верхняя граница: страховка от гипотезы «сервер прислал миллисекунды под видом секунд» */
export const MAX_PAUSE_MS = 60_000;
/** Пауза, когда сервер попросил подождать, но величина не разобрана */
export const DEFAULT_PAUSE_MS = MIN_PAUSE_MS;

/** Статус HTTP, которым сервер просит притормозить */
export const RATE_LIMIT_STATUS = 429;

/** Коды прикладного отказа, означающие лимит частоты */
const RATE_LIMIT_CODES = ['rate_limited', 'too_many_requests'] as const;

/** Как сырое значение было прочитано; уходит в лог, чтобы промах по единице был видим */
export type PauseInterpretation = 'seconds' | 'milliseconds' | 'http-date' | 'invalid';

/** Как результат лёг в допустимый диапазон */
export type PauseClamp = 'none' | 'min' | 'max';

interface ResolvedPause {
  pauseMs: number;
  interpretation: PauseInterpretation;
  clamp: PauseClamp;
}

export function isRateLimitCode(code: string | undefined): boolean {
  return code !== undefined && RATE_LIMIT_CODES.some((known) => known === code);
}

/** Достаёт `retry_after` из тела отказа: у REST и у Phoenix поле называется одинаково */
export function readRetryAfterField(payload: unknown): unknown {
  if (payload === null || typeof payload !== 'object') {
    return undefined;
  }
  return (payload as Record<string, unknown>)['retry_after'];
}

function clamp(rawMs: number): { pauseMs: number; clamp: PauseClamp } {
  if (rawMs < MIN_PAUSE_MS) {
    return { pauseMs: MIN_PAUSE_MS, clamp: 'min' };
  }
  if (rawMs > MAX_PAUSE_MS) {
    return { pauseMs: MAX_PAUSE_MS, clamp: 'max' };
  }
  return { pauseMs: rawMs, clamp: 'none' };
}

/** Число: величина сама выбирает трактовку, см. шапку модуля */
function fromNumber(value: number): ResolvedPause {
  const interpretation: PauseInterpretation = value < MIN_PAUSE_MS ? 'seconds' : 'milliseconds';
  const asMilliseconds = interpretation === 'seconds' ? value * 1_000 : value;
  return { interpretation, ...clamp(asMilliseconds) };
}

/**
 * Строка `Retry-After` бывает и датой. Дата не оставляет места догадкам про единицу:
 * из неё вычитается текущее время, и разность это уже миллисекунды по определению.
 */
function fromHttpDate(value: string): ResolvedPause | undefined {
  const deadline = Date.parse(value);
  if (Number.isNaN(deadline)) {
    return undefined;
  }
  return { interpretation: 'http-date', ...clamp(deadline - Date.now()) };
}

function interpret(raw: unknown): ResolvedPause {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw >= 0
      ? fromNumber(raw)
      : { pauseMs: DEFAULT_PAUSE_MS, interpretation: 'invalid', clamp: 'none' };
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      const asNumber = Number(trimmed);
      if (Number.isFinite(asNumber) && asNumber >= 0) {
        return fromNumber(asNumber);
      }
      const asDate = fromHttpDate(trimmed);
      if (asDate !== undefined) {
        return asDate;
      }
    }
  }
  return { pauseMs: DEFAULT_PAUSE_MS, interpretation: 'invalid', clamp: 'none' };
}

/**
 * Переводит сырое значение паузы в миллисекунды.
 *
 * Мусорное значение не игнорируется молча: сервер о паузе попросил, и раз он это сделал,
 * пауза берётся минимальная, а не нулевая. Молчаливый ноль означал бы, что просьбу разобрали
 * и выбросили, то есть худший исход из возможных.
 */
export function resolvePauseMs(raw: unknown, logger?: Logger): number {
  const resolved = interpret(raw);
  logger?.warn('лимит частоты: сервер попросил паузу', {
    rawPause: raw,
    interpretation: resolved.interpretation,
    clamp: resolved.clamp,
    pauseMs: resolved.pauseMs,
  });
  return resolved.pauseMs;
}
