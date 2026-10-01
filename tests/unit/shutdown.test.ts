/**
 * Порядок остановки: установщик браузера убивается раньше закрытия сокета. Закрытие сокета
 * асинхронное и кончается выходом процесса, после которого убивать уже некому.
 */
import { describe, expect, it, vi } from 'vitest';
import { createShutdown } from '../../src/shutdown.js';
import type { Logger } from '../../src/util/logger.js';

function silentLogger(): Logger {
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => logger),
  };
  return logger;
}

describe('остановка сервера', () => {
  it('убивает установщик до закрытия сокета и выходит с кодом причины один раз', async () => {
    const calls: string[] = [];
    const exited = new Promise<number>((resolve) => {
      const shutdown = createShutdown({
        ws: {
          close: vi.fn(async () => {
            calls.push('ws.close');
          }),
        },
        browserInstall: { kill: vi.fn(() => calls.push('browserInstall.kill')) },
        logger: silentLogger(),
        exit: (exitCode) => {
          calls.push('exit');
          resolve(exitCode);
        },
      });
      shutdown('SIGTERM', 143);
      shutdown('SIGINT', 130);
    });

    expect(await exited).toBe(143);
    expect(calls).toEqual(['browserInstall.kill', 'ws.close', 'exit']);
  });
});
