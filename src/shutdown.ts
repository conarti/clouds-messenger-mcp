/**
 * Остановка сервера: дочерний процесс установки браузера, затем сокет, затем выход.
 *
 * Вынесена из точки входа ради проверки порядка: точка входа запускает сервер при импорте,
 * и проверить её саму без настоящего процесса нельзя.
 */
import type { ChromiumInstallation } from './auth/chromiumInstall.js';
import type { PhoenixClient } from './transport/ws/types.js';
import type { Logger } from './util/logger.js';

export interface ShutdownOptions {
  ws: Pick<PhoenixClient, 'close'>;
  browserInstall: Pick<ChromiumInstallation, 'kill'>;
  logger: Logger;
  exit: (exitCode: number) => void;
}

export function createShutdown(options: ShutdownOptions): (reason: string, exitCode: number) => void {
  const { ws, browserInstall, logger, exit } = options;
  let stopping = false;
  return (reason, exitCode) => {
    if (stopping) {
      return;
    }
    stopping = true;
    logger.info('остановка сервера MCP', { reason });
    /*
     * Установщик убивается ДО закрытия сокета: закрытие асинхронное и кончается выходом
     * процесса, и убийство после него могло бы не успеть, оставив установщик жить без родителя.
     */
    browserInstall.kill();
    void ws
      .close()
      .catch((error: unknown) => {
        logger.warn('сокет не закрылся штатно', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        exit(exitCode);
      });
  };
}
