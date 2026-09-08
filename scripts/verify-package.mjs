#!/usr/bin/env node
/**
 * Проверка поставки: пакет собирается, пакуется, ставится в пустой каталог как чужой
 * пользователь и отвечает на tools/list.
 *
 * Почему именно так. Опубликованный пакет ломается не на сборке, а на стыках: забытый
 * файл в `files`, потерянный shebang, бинарь без права на исполнение, инструмент,
 * который есть в коде, но не зарегистрирован на сервере. Локальный `npm test` эти стыки
 * не видит, он работает с исходниками и с node_modules разработчика. Поэтому проверка
 * идёт через реальный тарбол и отдельный каталог установки.
 *
 * Сервер поднимается с подменёнными HOME и CLOUDS_MESSENGER_MCP_CONFIG (путь к заведомо
 * отсутствующему файлу): так проверка не читает конфиг и профиль пользователя, а сервер
 * стартует на дефолтах. Ответ на tools/list обязан прийти без сессии и без сети,
 * авторизация в Playwright поднимается лениво, на первом вызове инструмента.
 *
 * Эталон списка инструментов это TOOL_NAMES из собранного dist/server.js. Расхождение
 * между эталоном и живым ответом tools/list означает, что инструмент объявлен, но не
 * зарегистрирован (или наоборот), и это провал проверки с кодом 1.
 *
 * Требуется Node 22 или новее.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN_NAME = 'clouds-messenger-mcp';
const STARTUP_TIMEOUT_MS = 30_000;

/** Каталоги, созданные проверкой: удаляются в finally, даже если проверка упала */
const temporaryDirs = [];

function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirs.push(dir);
  return dir;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

/**
 * Таймаут на весь старт сервера: зависший дочерний процесс должен провалить проверку,
 * а не держать её бесконечно.
 */
function withTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`превышен таймаут ${ms} мс: ${label}`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

function packTarball(packDir) {
  const raw = run('npm', ['pack', '--json', '--pack-destination', packDir], { cwd: ROOT });
  /* npm может дописать в stdout служебные строки, JSON начинается с первой скобки массива */
  const start = raw.indexOf('[');
  if (start < 0) {
    throw new Error(`npm pack не вернул JSON: ${raw}`);
  }
  const entries = JSON.parse(raw.slice(start));
  const filename = entries[0]?.filename;
  if (typeof filename !== 'string') {
    throw new Error('npm pack не сообщил имя тарбола');
  }
  return join(packDir, filename);
}

function installTarball(installDir, tarball) {
  run('npm', ['init', '-y'], { cwd: installDir });
  run('npm', ['install', tarball], {
    cwd: installDir,
    env: {
      ...process.env,
      /*
       * Браузер Playwright весит сотни мегабайт и проверке поставки не нужен: тут
       * проверяется состав пакета и ответ на tools/list, а не живая авторизация.
       */
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
    },
  });
}

async function listToolsFromInstalledBinary(installDir, homeDir) {
  const binary = join(installDir, 'node_modules', '.bin', BIN_NAME);
  if (!existsSync(binary)) {
    throw new Error(`бинарь не появился после установки: ${binary}`);
  }

  const transport = new StdioClientTransport({
    command: binary,
    cwd: installDir,
    env: {
      ...getDefaultEnvironment(),
      /* Подменённый дом: ни профиль, ни загрузки пользователя проверка не трогает */
      HOME: homeDir,
      /* Заведомо отсутствующий файл: загрузка конфига обязана упасть на дефолты */
      CLOUDS_MESSENGER_MCP_CONFIG: join(homeDir, 'config-которого-нет.json'),
    },
    stderr: 'pipe',
  });

  const stderrChunks = [];
  transport.stderr?.on('data', (chunk) => stderrChunks.push(String(chunk)));

  const client = new Client({ name: 'verify-package', version: '1.0.0' });
  let pid = null;
  try {
    await withTimeout(client.connect(transport), STARTUP_TIMEOUT_MS, 'подключение к серверу');
    pid = transport.pid;
    const listed = await withTimeout(client.listTools(), STARTUP_TIMEOUT_MS, 'запрос tools/list');
    return { names: listed.tools.map((tool) => tool.name), stderrChunks, pid };
  } finally {
    await client.close();
    /* Процесс обязан умереть вместе с транспортом: иначе проверка оставляет мусор в системе */
    if (pid !== null) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      try {
        process.kill(pid, 0);
        throw new Error(`процесс сервера ${pid} остался жив после close`);
      } catch (error) {
        if (error.code !== 'ESRCH') {
          throw error;
        }
      }
    }
  }
}

async function main() {
  log('сборка пакета');
  run('npm', ['run', 'build'], { cwd: ROOT });

  const packDir = makeTempDir('clouds-messenger-mcp-pack-');
  const installDir = makeTempDir('clouds-messenger-mcp-install-');
  const homeDir = makeTempDir('clouds-messenger-mcp-home-');

  const tarball = packTarball(packDir);
  log(`тарбол: ${tarball}`);

  log('чистая установка тарбола');
  installTarball(installDir, tarball);

  log('запуск установленного бинаря и запрос tools/list');
  const { names, stderrChunks, pid } = await listToolsFromInstalledBinary(installDir, homeDir);

  /* Эталон берётся из собранного dist, а не из исходников: сверяем то, что реально уехало в пакет */
  const { TOOL_NAMES } = await import(join(ROOT, 'dist', 'server.js'));
  const expected = new Set(TOOL_NAMES);
  const actual = new Set(names);
  const missing = [...expected].filter((name) => !actual.has(name));
  const extra = [...actual].filter((name) => !expected.has(name));

  const stderrText = stderrChunks.join('');
  /* Стартовать сервер обязан молча по части ошибок: сеть и авторизация тут не поднимаются */
  const suspiciousLines = stderrText
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .filter((line) => /"level":"(error|fatal)"|авториз|unauthor|ECONNREFUSED|ENOTFOUND/i.test(line));

  log('');
  log(`инструментов в ответе: ${actual.size}, ожидалось: ${expected.size}`);
  log(`ответившие инструменты: ${[...actual].join(', ')}`);
  log(`pid сервера завершён: ${pid}`);

  let failed = false;
  if (missing.length > 0) {
    failed = true;
    log(`НЕ ЗАРЕГИСТРИРОВАНЫ (есть в TOOL_NAMES, нет в tools/list): ${missing.join(', ')}`);
  }
  if (extra.length > 0) {
    failed = true;
    log(`ЛИШНИЕ (есть в tools/list, нет в TOOL_NAMES): ${extra.join(', ')}`);
  }
  if (suspiciousLines.length > 0) {
    failed = true;
    log('ПОДОЗРИТЕЛЬНЫЙ STDERR СЕРВЕРА:');
    for (const line of suspiciousLines) {
      log(`  ${line}`);
    }
  }

  if (failed) {
    log('');
    log('ПРОВЕРКА ПОСТАВКИ ПРОВАЛЕНА');
    process.exitCode = 1;
    return;
  }

  log('');
  log('ПРОВЕРКА ПОСТАВКИ ПРОЙДЕНА');
}

try {
  await main();
} catch (error) {
  process.stderr.write(`проверка поставки упала: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
} finally {
  for (const dir of temporaryDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
}
