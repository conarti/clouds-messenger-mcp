#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { sweepDownloads } from './attachments/cleanup.js';
import { AuthKeyStore } from './auth/keyStore.js';
import { PlaywrightProfileAuth } from './auth/PlaywrightProfileAuth.js';
import { loadConfig } from './config/loadConfig.js';
import { SodiumCryptoService } from './crypto/service.js';
import { createServer } from './server.js';
import { HttpRestClient } from './transport/RestClient.js';
import { PhoenixWsClient } from './transport/ws/PhoenixClient.js';
import { createLogger } from './util/logger.js';

async function main(): Promise<void> {
  const logger = createLogger({ bindings: { component: 'main' } });
  const config = loadConfig();

  logger.info('запуск сервера MCP', {
    configFile: config.paths.configFile,
    profileDir: config.paths.profileDir,
    downloadsDir: config.paths.downloadsDir,
  });

  /*
   * Подметание загрузок на старте: скачанное вложение это копия чужой переписки на диске, и
   * жить дольше TTL она не должна. Отказ подметания НЕ мешает старту: невыметенный старый
   * файл это гигиена, а несостоявшийся сервер это отсутствие инструмента целиком.
   */
  try {
    const swept = await sweepDownloads({
      downloadsDir: config.paths.downloadsDir,
      ttlDays: config.downloads.ttlDays,
      logger,
    });
    logger.info('загрузки подметены', { removed: swept.removed, kept: swept.kept });
  } catch (error) {
    logger.warn('подметание загрузок не выполнено, старт продолжается', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  /*
   * Сборка БЕЗ ввода-вывода: браузер не поднимается, сокет не открывается, профиль не
   * читается. Авторизация случится лениво, на первом вызове инструмента, который реально
   * идёт к серверу: `tools/list` обязан отвечать и без живой сессии.
   */
  const auth = new PlaywrightProfileAuth({ config, logger });
  const ws = new PhoenixWsClient({ auth, config, logger });
  const rest = new HttpRestClient({ auth, config, logger });
  const crypto = new SodiumCryptoService({ rest, logger });
  const keyStore = new AuthKeyStore(auth);

  const server = createServer({
    config,
    logger,
    deps: { ws, rest, auth, crypto, keyStore, config, logger },
  });
  const transport = new StdioServerTransport();

  /*
   * Выход закрывает сокет. Транспорт stdio закрывается, когда уходит клиент MCP, сигналы
   * приходят от того, кто запустил процесс: в обоих случаях живое соединение с сервером
   * задержало бы процесс на своём таймауте и оставило бы сессию открытой на той стороне.
   *
   * Обработчик ставится ДО подключения намеренно: транспорт принадлежит SDK, и при
   * подключении SDK подменяет `onclose` своим, сохранив уже назначенный и вызывая его
   * первым. Назначение после подключения затёрло бы обработчик самого SDK.
   *
   * Отказ закрытия уходит только в лог: он не меняет того, что процесс уходит, а
   * ненулевой код выхода на несостоявшемся закрытии читался бы как отказ сервера.
   *
   * КОД ВЫХОДА ЗАВИСИТ ОТ ПРИЧИНЫ ОСТАНОВА, А НЕ ОТ ИСХОДА ЗАКРЫТИЯ СОКЕТА. Закрытие
   * транспорта stdio это штатный уход клиента MCP, и код в этом случае 0. Сигнал ОС это
   * не наш выбор, а решение того, кто запустил процесс, и оболочка с супервизорами
   * (systemd, pm2, docker) ждут по конвенции код 128 + номер сигнала (SIGINT -> 130,
   * SIGTERM -> 143), чтобы отличить смерть по сигналу от обычного завершения и решить,
   * перезапускать ли процесс.
   */
  let stopping = false;
  const shutdown = (reason: string, exitCode: number): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    logger.info('остановка сервера MCP', { reason });
    void ws
      .close()
      .catch((error: unknown) => {
        logger.warn('сокет не закрылся штатно', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        process.exit(exitCode);
      });
  };

  transport.onclose = () => shutdown('транспорт stdio закрыт', 0);
  process.on('SIGINT', () => shutdown('SIGINT', 130));
  process.on('SIGTERM', () => shutdown('SIGTERM', 143));

  await server.connect(transport);

  logger.info('сервер MCP подключён по stdio');
}

main().catch((error: unknown) => {
  /* Логгер может быть ещё не создан, если упал loadConfig: пишем напрямую в stderr */
  process.stderr.write(
    `${JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      msg: 'fatal: сервер не поднялся',
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exitCode = 1;
});
