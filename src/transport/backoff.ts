/**
 * Пауза между попытками поднять соединение.
 *
 * Джиттера нет сознательно: клиент в процессе один, разводить стадо нечего, а
 * детерминированная задержка проверяется тестом без подмены таймеров.
 *
 * Пауза растёт экспоненциально и упирается в потолок: сервер, уронивший соединение,
 * чаще всего занят или перезапускается, и линейный повтор превращается в шторм.
 */

/** База роста, если вызывающий не передал свою */
export const DEFAULT_BASE_DELAY_MS = 500;
/** Потолок паузы: дальше ожидание перестаёт отличаться от зависания */
export const DEFAULT_MAX_DELAY_MS = 10_000;

export interface BackoffConfig {
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/** Пауза перед попыткой `attempt`, где 1 это первый повтор */
export function exponentialDelayMs(attempt: number, config: BackoffConfig = {}): number {
  const base = config.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const max = config.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  return Math.min(base * 2 ** Math.max(0, attempt - 1), max);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
