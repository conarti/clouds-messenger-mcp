/**
 * Автоустановка Chromium без настоящей загрузки.
 *
 * Процесс установки подменяется через шов запуска: настоящий установщик качает 150 МБ и
 * зависит от сети, а проверяется здесь не он, а наше обращение с ним: аргументы, разбор
 * прогресса, срок, текст отказа, повтор после отказа и то, что отказ не теряется.
 */
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  BrowserInstallError,
  ChromiumInstallation,
  browserInstallInProgress,
  chromiumExecutablesExist,
  parseInstallProgress,
  playwrightVersion,
  requiredExecutablePaths,
  type ChromiumInstallationOptions,
  type InstallerProcess,
} from '../../src/auth/chromiumInstall.js';
import type { Logger } from '../../src/util/logger.js';

const PLAYWRIGHT_CORE = { cliPath: '/opt/node_modules/playwright-core/cli.js', version: '1.63.0' };

class FakeInstallerProcess extends EventEmitter implements InstallerProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killSignals: (NodeJS.Signals | undefined)[] = [];

  /** Процесс, который на SIGTERM не уходит: так видна эскалация до SIGKILL */
  constructor(private readonly ignoresTerm = false) {
    super();
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killSignals.push(signal);
    if (!this.ignoresTerm || signal === 'SIGKILL') {
      setImmediate(() => this.emit('close', null, signal ?? 'SIGTERM'));
    }
    return true;
  }

  finish(code: number): void {
    this.emit('close', code, null);
  }
}

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

interface HarnessOptions extends Partial<ChromiumInstallationOptions> {
  ignoresTerm?: boolean;
}

/** Установка на подложном диске: сборки появляются на нём, только когда тест так решит */
function createInstallation(options: HarnessOptions = {}) {
  const { ignoresTerm, ...overrides } = options;
  const disk = { present: false };
  const children: FakeInstallerProcess[] = [];
  const spawnInstaller = vi.fn((_command: string, _args: string[]) => {
    const child = new FakeInstallerProcess(ignoresTerm);
    children.push(child);
    return child;
  });
  const installation = new ChromiumInstallation({
    timeoutMs: 5_000,
    logger: silentLogger(),
    spawnInstaller,
    executableExists: () => disk.present,
    platform: 'darwin',
    playwrightCore: PLAYWRIGHT_CORE,
    ...overrides,
  });
  const lastChild = (): FakeInstallerProcess => {
    const child = children.at(-1);
    if (child === undefined) {
      throw new Error('процесс установки не порождён');
    }
    return child;
  };
  /** Установщик доехал: сборки на диске, процесс вышел с нулём */
  const succeed = (): void => {
    disk.present = true;
    lastChild().finish(0);
  };
  return { disk, children, lastChild, succeed, spawnInstaller, installation };
}

/** Несколько оборотов цикла событий: столько нужно отказу, чтобы стать unhandledRejection */
async function drainEventLoop(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('проверка сборок на диске', () => {
  it('нужны и headless-оболочка, и полный Chromium: одной из двух недостаточно', () => {
    const paths = () => ['/cache/chromium_headless_shell/shell', '/cache/chromium/chrome'];

    expect(chromiumExecutablesExist(paths, (path) => path.includes('chromium/chrome'))).toBe(false);
    expect(chromiumExecutablesExist(paths, (path) => path.includes('headless_shell'))).toBe(false);
    expect(chromiumExecutablesExist(paths, () => true)).toBe(true);
  });

  it('реестр playwright-core отдаёт пути обеих сборок', () => {
    const paths = requiredExecutablePaths();

    expect(paths).toHaveLength(2);
    expect(paths[0]).toMatch(/headless_shell/);
  });

  it('сбой чтения реестра даёт «неизвестно», а не падение', () => {
    const broken = () => {
      throw new Error('реестр недоступен');
    };

    expect(chromiumExecutablesExist(broken, () => true)).toBeUndefined();
  });

  it('реестр не читается: нулевой код выхода установщика считается готовностью', async () => {
    const { installation, lastChild } = createInstallation({ executableExists: () => undefined });

    const ensured = installation.ensure();
    lastChild().finish(0);
    await ensured;

    expect(await installation.waitFor(0)).toBe('ready');
  });
});

describe('сборки уже на диске', () => {
  it('ensure резолвится сразу, процесс не порождается', async () => {
    const { installation, spawnInstaller, disk } = createInstallation();
    disk.present = true;

    await installation.ensure();

    expect(spawnInstaller).not.toHaveBeenCalled();
    expect(await installation.waitFor(0)).toBe('ready');
  });
});

describe('сборок нет', () => {
  it('запускает cli.js playwright-core текущим node с install chromium, вместе с headless-оболочкой', async () => {
    const { installation, spawnInstaller, succeed } = createInstallation();

    const ensured = installation.ensure();
    succeed();
    await ensured;

    expect(spawnInstaller).toHaveBeenCalledTimes(1);
    expect(spawnInstaller).toHaveBeenCalledWith(process.execPath, [PLAYWRIGHT_CORE.cliPath, 'install', 'chromium']);
  });

  it('повторный старт во время попытки не порождает второй процесс', async () => {
    const { installation, spawnInstaller, succeed } = createInstallation();

    void installation.start();
    void installation.start();
    succeed();
    await installation.ensure();

    expect(spawnInstaller).toHaveBeenCalledTimes(1);
  });

  it('нулевой код выхода без сборок на диске это отказ, а не готовность', async () => {
    const { installation, lastChild } = createInstallation();

    const ensured = installation.ensure();
    lastChild().finish(0);

    await expect(ensured).rejects.toThrow('нужных входу сборок на диске нет');
  });

  it('разбирает строки прогресса, склеивая разрезанные куски, и не пишет вывод в наш stdout', async () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write');
    const { installation, lastChild, succeed } = createInstallation();
    const seen: number[] = [];
    installation.onProgress((progress) => seen.push(progress.percent));

    const ensured = installation.ensure();
    const child = lastChild();
    child.stdout.write('Downloading Chromium 140.0 (playwright build v1187)\n');
    child.stdout.write('|■■■■■■■■      |  4');
    await drainEventLoop();
    child.stdout.write('0% of 150.2 MiB\n|■■■■■■■■■■■■■■| 100% of 150.2 MiB\n');
    await drainEventLoop();
    succeed();
    await ensured;

    expect(seen).toEqual([40, 100]);
    expect(installation.currentProgress).toEqual({ percent: 100, total: '150.2 MiB' });
    expect(stdoutWrite).not.toHaveBeenCalled();
    stdoutWrite.mockRestore();
  });
});

describe('parseInstallProgress', () => {
  it('достаёт процент и объём, чужую строку пропускает', () => {
    expect(parseInstallProgress('|■■■■   |  40% of 150 MiB')).toEqual({ percent: 40, total: '150 MiB' });
    expect(parseInstallProgress('Chromium downloaded to /cache')).toBeUndefined();
  });
});

describe('отказ установки', () => {
  it('ненулевой код выхода даёт ошибку с хвостом stderr и командой для точной версии', async () => {
    const { installation, lastChild } = createInstallation();

    const ensured = installation.ensure();
    lastChild().stderr.write('Error: getaddrinfo ENOTFOUND cdn.playwright.dev\n');
    await drainEventLoop();
    lastChild().finish(1);

    const error = await ensured.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BrowserInstallError);
    const message = (error as BrowserInstallError).message;
    expect(message).toContain('ENOTFOUND');
    expect(message).toContain('npx playwright@1.63.0 install chromium');
    expect(message).not.toContain('install-deps');
    expect((error as BrowserInstallError).stderrTail).toContain('ENOTFOUND');
  });

  it('на linux подсказывает установку системных библиотек', async () => {
    const { installation, lastChild } = createInstallation({ platform: 'linux' });

    const ensured = installation.ensure();
    lastChild().finish(1);

    await expect(ensured).rejects.toThrow('sudo npx playwright@1.63.0 install-deps chromium');
  });

  it('истечение срока убивает процесс и завершает ожидание отказом', async () => {
    const { installation, lastChild } = createInstallation({ timeoutMs: 20 });

    await expect(installation.ensure()).rejects.toThrow('не уложилась в 20 мс');
    expect(lastChild().killSignals).toEqual(['SIGTERM']);
  });

  it('ранний отказ не становится unhandledRejection и сохраняется до следующей попытки', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const { installation, lastChild } = createInstallation();

      void installation.start();
      lastChild().finish(1);
      await drainEventLoop();

      expect(unhandled).not.toHaveBeenCalled();
      expect(installation.failure).toBeInstanceOf(BrowserInstallError);
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('отказ не окончательный', () => {
  it('браузер поставили руками: следующий вызов видит сборки и не качает заново', async () => {
    const { installation, lastChild, disk, spawnInstaller } = createInstallation();

    const first = installation.ensure();
    lastChild().finish(1);
    await expect(first).rejects.toBeInstanceOf(BrowserInstallError);

    disk.present = true;

    expect(await installation.waitFor(0)).toBe('ready');
    await installation.ensure();
    expect(spawnInstaller).toHaveBeenCalledTimes(1);
    expect(installation.failure).toBeUndefined();
  });

  it('после паузы ожидание с бюджетом запускает новую попытку, и она может удаться', async () => {
    const { installation, lastChild, succeed, spawnInstaller } = createInstallation({ retryCooldownMs: 0 });

    const first = installation.ensure();
    lastChild().finish(1);
    await expect(first).rejects.toBeInstanceOf(BrowserInstallError);

    const waiting = installation.waitFor(1_000);
    expect(spawnInstaller).toHaveBeenCalledTimes(2);
    succeed();
    expect(await waiting).toBe('ready');
    await installation.ensure();
  });

  it('один вызов инструмента после отказа порождает не больше одного установщика', async () => {
    const { installation, lastChild, spawnInstaller } = createInstallation({ retryCooldownMs: 0 });

    const first = installation.ensure();
    lastChild().finish(1);
    await expect(first).rejects.toBeInstanceOf(BrowserInstallError);

    /* Вызов инструмента: ожидание с бюджетом, затем вход через ensure */
    const waiting = installation.waitFor(1_000);
    lastChild().finish(1);
    expect(await waiting).toBe('failed');
    await expect(installation.ensure()).rejects.toBeInstanceOf(BrowserInstallError);

    expect(spawnInstaller).toHaveBeenCalledTimes(2);
  });

  it('в паузе после отказа новая попытка не запускается, но диск проверяется', async () => {
    const { installation, lastChild, disk, spawnInstaller } = createInstallation({ retryCooldownMs: 60_000 });

    const first = installation.ensure();
    lastChild().finish(1);
    await expect(first).rejects.toBeInstanceOf(BrowserInstallError);

    expect(await installation.waitFor(1_000)).toBe('failed');
    expect(installation.failure).toBeInstanceOf(BrowserInstallError);
    expect(spawnInstaller).toHaveBeenCalledTimes(1);

    disk.present = true;
    expect(await installation.waitFor(1_000)).toBe('ready');
    expect(spawnInstaller).toHaveBeenCalledTimes(1);
  });
});

describe('ожидание с бюджетом и остановка', () => {
  it('установка не уложилась в бюджет: ожидание отдаёт pending, а не ошибку', async () => {
    const { installation, lastChild, succeed } = createInstallation();

    void installation.start();
    lastChild().stdout.write('|■■■■   |  40% of 150.2 MiB\n');
    await drainEventLoop();

    expect(await installation.waitFor(10)).toBe('pending');
    expect(browserInstallInProgress(installation.currentProgress)).toEqual({
      status: 'browser_install_in_progress',
      percent: 40,
      total: '150.2 MiB',
      next_step: expect.stringContaining('повторите вызов'),
    });
    succeed();
  });

  it('kill убивает идущий процесс установки', async () => {
    const { installation, lastChild } = createInstallation();

    const ensured = installation.ensure().catch(() => undefined);
    installation.kill();
    await ensured;

    expect(lastChild().killSignals).toEqual(['SIGTERM']);
  });

  it('процесс, не ушедший по SIGTERM, получает SIGKILL после паузы', async () => {
    const { installation, lastChild } = createInstallation({ ignoresTerm: true, killGraceMs: 10 });

    const ensured = installation.ensure().catch(() => undefined);
    installation.kill();
    await ensured;

    expect(lastChild().killSignals).toEqual(['SIGTERM', 'SIGKILL']);
  });
});

describe('команда ручной установки в README', () => {
  it('называет ту же версию playwright, что зафиксирована в package.json', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { dependencies: Record<string, string> };
    const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
    const pinned = packageJson.dependencies['playwright'];
    const mentioned = [...readme.matchAll(/npx playwright@([^\s`]+)/g)].map((match) => match[1]);

    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    expect(playwrightVersion()).toBe(pinned);
    expect(mentioned.length).toBeGreaterThan(0);
    expect(new Set(mentioned)).toEqual(new Set([pinned]));
  });
});
