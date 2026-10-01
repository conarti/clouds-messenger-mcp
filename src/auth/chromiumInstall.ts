/**
 * Автоустановка Chromium для Playwright.
 *
 * Сборка ставится ДОЧЕРНИМ процессом, а не вызовом реестра Playwright в своём процессе:
 * установщик печатает прогресс прямо в стандартный вывод, а стандартный вывод принадлежит
 * протоколу MCP, и посторонний байт в нём роняет сессию целиком.
 *
 * Параллельные установки из нескольких процессов безопасны: Playwright держит блокировку
 * каталога браузеров, второй процесс дождётся первого и повторно качать не станет.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Logger } from '../util/logger.js';
import { AuthError } from './AuthProvider.js';

/** Сколько последних символов stderr попадает в текст отказа: хвост несёт причину, начало шум */
const STDERR_TAIL_LENGTH = 2_000;

/** Строка прогресса установщика: `|■■■■      |  40% of 150.2 MiB` */
const PROGRESS_PATTERN = /(\d{1,3})% of ([\d.]+ ?[KMGT]?i?B)/;

export interface InstallProgress {
  percent: number;
  /** Объём архива строкой установщика, например `150.2 MiB` */
  total: string;
}

/** Дочерний процесс в объёме, который нужен установке: настоящий `ChildProcess` подходит как есть */
export interface InstallerProcess {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: 'error', handler: (error: Error) => void): unknown;
  on(event: 'close', handler: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

/** Шов запуска процесса: проверять установку настоящей загрузкой в 150 МБ нельзя */
export type SpawnInstaller = (command: string, args: string[]) => InstallerProcess;

/** Отказ установки: несёт хвост stderr и команду ручной установки для точной версии */
export class BrowserInstallError extends Error {
  constructor(
    message: string,
    readonly stderrTail: string,
  ) {
    super(message);
    this.name = 'BrowserInstallError';
  }
}

/** Реестр браузеров playwright-core в объёме, который нужен проверке путей */
interface BrowserRegistry {
  findExecutable(name: string): { executablePath(): string | undefined } | undefined;
}

/**
 * Сборки, которые реально запускает вход: headless-оболочка для тихой попытки и полный
 * Chromium для окна ручного входа. Проверка одного `chromium.executablePath()` пропустила бы
 * отсутствующую headless-оболочку, и тихая попытка упала бы сырой ошибкой Playwright.
 */
const REQUIRED_BROWSERS = ['chromium-headless-shell', 'chromium'] as const;

/** require от каталога `playwright`: `playwright-core` это его зависимость и лежит рядом с ним */
function playwrightRequire(): NodeJS.Require {
  return createRequire(createRequire(import.meta.url).resolve('playwright'));
}

/**
 * Пути сборок из реестра playwright-core. Реестр только читается: установка в своём процессе
 * писала бы прогресс в стандартный вывод.
 */
export function requiredExecutablePaths(): string[] {
  const bundle = playwrightRequire()('playwright-core/lib/coreBundle') as {
    registry?: { registry?: BrowserRegistry };
  };
  const registry = bundle.registry?.registry;
  if (registry === undefined) {
    throw new Error('в playwright-core не найден реестр браузеров');
  }
  return REQUIRED_BROWSERS.map((name) => {
    const path = registry.findExecutable(name)?.executablePath();
    if (path === undefined) {
      throw new Error(`реестр playwright-core не знает путь сборки ${name}`);
    }
    return path;
  });
}

/**
 * Есть ли на диске КАЖДАЯ сборка, нужная входу. `executablePath()` возвращает путь и тогда,
 * когда файла нет, поэтому проверка существования обязательна.
 *
 * undefined значит «неизвестно»: реестр не прочитался. Тогда решает установщик: он сам видит,
 * что уже на месте, а его нулевой код выхода считается готовностью. Сборку, которой всё же
 * нет, отдаст внятным отказом запуск браузера.
 */
export function chromiumExecutablesExist(
  resolvePaths: () => string[] = requiredExecutablePaths,
  fileExists: (path: string) => boolean = existsSync,
): boolean | undefined {
  let paths: string[];
  try {
    paths = resolvePaths();
  } catch {
    return undefined;
  }
  return paths.every(fileExists);
}

/** Точная версия `playwright` из зависимостей: от неё зависит ревизия Chromium */
export function playwrightVersion(): string {
  const packageJsonPath = createRequire(import.meta.url).resolve('playwright/package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: unknown };
  if (typeof packageJson.version !== 'string') {
    throw new Error(`в ${packageJsonPath} нет версии playwright`);
  }
  return packageJson.version;
}

/** Признак сырой ошибки Playwright об отсутствующей сборке браузера */
export function isMissingExecutableError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Executable doesn't exist");
}

/** Разбор строки вывода установщика в процент и объём; чужая строка даёт undefined */
export function parseInstallProgress(line: string): InstallProgress | undefined {
  const match = PROGRESS_PATTERN.exec(line);
  if (match === null) {
    return undefined;
  }
  const percent = Number(match[1]);
  const total = match[2];
  if (!Number.isFinite(percent) || percent > 100 || total === undefined) {
    return undefined;
  }
  return { percent, total };
}

/** Путь к CLI playwright-core и точная версия playwright */
function resolvePlaywrightCore(): { cliPath: string; version: string } {
  const packageJsonPath = playwrightRequire().resolve('playwright-core/package.json');
  return { cliPath: join(dirname(packageJsonPath), 'cli.js'), version: playwrightVersion() };
}

/** Команды ручной установки для точной версии: `npx playwright` без версии взял бы чужую ревизию */
function manualInstallHint(version: string, platform: NodeJS.Platform): string {
  const install = `npx playwright@${version} install chromium`;
  if (platform !== 'linux') {
    return `Установите браузер вручную: ${install}`;
  }
  return (
    `Установите браузер вручную: ${install}. Если не хватает системных библиотек: ` +
    `sudo npx playwright@${version} install-deps chromium`
  );
}

function defaultSpawnInstaller(command: string, args: string[]): InstallerProcess {
  /* stdout только в pipe: в наш stdout вывод установщика не попадает никогда */
  return spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

export interface ChromiumInstallationOptions {
  /** Общий срок установки: по истечении процесс убивается, ожидание завершается отказом */
  timeoutMs: number;
  logger: Logger;
  spawnInstaller?: SpawnInstaller;
  /** true, false либо undefined, когда проверить нельзя */
  executableExists?: () => boolean | undefined;
  platform?: NodeJS.Platform;
  /** Подменяется в тестах вместе с запуском процесса, чтобы не резолвить настоящий пакет */
  playwrightCore?: { cliPath: string; version: string };
  /** Сколько процесс получает на штатное завершение после SIGTERM, прежде чем получить SIGKILL */
  killGraceMs?: number;
  /** Сколько после отказа новая попытка не запускается: сеть, упавшая только что, ещё лежит */
  retryCooldownMs?: number;
}

type InstallOutcome = { kind: 'pending' } | { kind: 'ready' } | { kind: 'failed'; error: Error };

/** Исход ожидания с бюджетом: `pending` значит, что установка ещё идёт */
export type InstallWaitResult = 'ready' | 'failed' | 'pending';

/** Пауза между SIGTERM и SIGKILL: установщику хватает её, чтобы снять блокировку каталога */
const DEFAULT_KILL_GRACE_MS = 3_000;

/** Пауза перед повтором после отказа: каждый вызов инструмента иначе запускал бы загрузку заново */
const DEFAULT_RETRY_COOLDOWN_MS = 30_000;

/**
 * Установка Chromium с осевшим результатом.
 *
 * Promise попытки создаётся один раз, и обработчик отказа вешается на него В МОМЕНТ
 * СОЗДАНИЯ, а исход сохраняется в поле. Без этого отказ, случившийся раньше первого вызова
 * инструмента, стал бы `unhandledRejection` и уронил бы процесс Node целиком.
 *
 * Отказ не окончательный: старт после отказа сначала заново смотрит на диск (пользователь мог
 * поставить браузер руками), а если сборок всё ещё нет и пауза после отказа прошла, запускает
 * новую попытку. Попытка в полёте всегда одна.
 *
 * Повтор запускает только старт (его зовёт ожидание с бюджетом), а не `ensure`: иначе вход,
 * пришедший следом за проваленным ожиданием, запускал бы вторую загрузку уже без бюджета.
 */
export class ChromiumInstallation {
  private outcome: InstallOutcome = { kind: 'pending' };
  private inFlight: Promise<void> | undefined;
  private attempted = false;
  private failedAt = 0;
  private child: InstallerProcess | undefined;
  private progress: InstallProgress | undefined;
  private readonly progressListeners = new Set<(progress: InstallProgress) => void>();

  constructor(private readonly options: ChromiumInstallationOptions) {}

  /** Последний разобранный прогресс; до первой строки установщика его нет */
  get currentProgress(): InstallProgress | undefined {
    return this.progress;
  }

  /** Ошибка последней попытки, если она кончилась отказом и новая ещё не началась */
  get failure(): Error | undefined {
    return this.outcome.kind === 'failed' ? this.outcome.error : undefined;
  }

  /** Запускает установку, если сборок нет. Пока попытка идёт или длится пауза, новая не порождается */
  start(): Promise<void> {
    if (this.outcome.kind === 'ready') {
      return Promise.resolve();
    }
    if (this.inFlight !== undefined) {
      return this.inFlight;
    }
    if (this.foundOnDisk()) {
      return Promise.resolve();
    }
    const cooldownMs = this.options.retryCooldownMs ?? DEFAULT_RETRY_COOLDOWN_MS;
    if (this.outcome.kind === 'failed' && Date.now() - this.failedAt < cooldownMs) {
      return Promise.resolve();
    }
    this.attempted = true;
    this.outcome = { kind: 'pending' };
    this.progress = undefined;
    const attempt = this.install()
      .then(
        () => {
          this.outcome = { kind: 'ready' };
        },
        (error: unknown) => {
          const failure = error instanceof Error ? error : new Error(String(error));
          this.outcome = { kind: 'failed', error: failure };
          this.failedAt = Date.now();
          this.options.logger.error('установка Chromium не удалась', { error: failure.message });
        },
      )
      .finally(() => {
        this.inFlight = undefined;
      });
    this.inFlight = attempt;
    return attempt;
  }

  /**
   * Дожидается идущей попытки либо отдаёт сохранённый отказ. Новую попытку запускает, только
   * если не было ни одной (вход без ожидания с бюджетом, например живой smoke).
   */
  async ensure(): Promise<void> {
    if (this.inFlight !== undefined) {
      await this.inFlight;
    } else if (!this.attempted) {
      await this.start();
    } else if (this.outcome.kind === 'failed') {
      this.foundOnDisk();
    }
    if (this.outcome.kind === 'failed') {
      throw this.outcome.error;
    }
  }

  /** Сборки на месте: исход становится готовностью. Неизвестность готовностью не считается */
  private foundOnDisk(): boolean {
    const executableExists = this.options.executableExists ?? chromiumExecutablesExist;
    if (executableExists() === true) {
      this.outcome = { kind: 'ready' };
      return true;
    }
    return false;
  }

  /** Ждёт установку не дольше бюджета и сообщает, чем ожидание кончилось */
  async waitFor(budgetMs: number): Promise<InstallWaitResult> {
    const attempt = this.start();
    if (this.outcome.kind === 'pending') {
      let timer: NodeJS.Timeout | undefined;
      const budget = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, budgetMs);
      });
      await Promise.race([attempt, budget]);
      clearTimeout(timer);
    }
    return this.outcome.kind;
  }

  /** Подписка на прогресс; возвращает отписку */
  onProgress(listener: (progress: InstallProgress) => void): () => void {
    this.progressListeners.add(listener);
    return () => {
      this.progressListeners.delete(listener);
    };
  }

  /** Убивает дочерний процесс: при остановке сервера он не должен пережить родителя */
  kill(): void {
    if (this.child !== undefined) {
      this.terminate(this.child);
    }
  }

  /** SIGTERM, а если процесс не ушёл за паузу, SIGKILL: зависший установщик не держит сервер */
  private terminate(child: InstallerProcess): void {
    child.kill('SIGTERM');
    const escalation = setTimeout(() => {
      if (this.child === child) {
        child.kill('SIGKILL');
      }
    }, this.options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
    escalation.unref();
  }

  /** Строки прогресса из вывода установщика; хвост без перевода строки ждёт следующего куска */
  private readProgress(text: string): void {
    for (const line of text.split(/[\r\n]+/)) {
      const progress = parseInstallProgress(line);
      if (progress === undefined || progress.percent === this.progress?.percent) {
        continue;
      }
      this.progress = progress;
      this.options.logger.info('установка Chromium', { percent: progress.percent, total: progress.total });
      for (const listener of this.progressListeners) {
        listener(progress);
      }
    }
  }

  /* async ради отказа, а не исключения: синхронный сбой резолва пакета тоже обязан осесть */
  private async install(): Promise<void> {
    const { logger, timeoutMs } = this.options;
    const platform = this.options.platform ?? process.platform;
    const { cliPath, version } = this.options.playwrightCore ?? resolvePlaywrightCore();
    const spawnInstaller = this.options.spawnInstaller ?? defaultSpawnInstaller;

    logger.info('Chromium не найден, начинается установка', { version, timeoutMs });

    return new Promise<void>((resolve, reject) => {
      let stderrTail = '';
      let partialLine = '';
      let finished = false;
      const fail = (reason: string): void => {
        const message = `Chromium не установлен: ${reason}. ${manualInstallHint(version, platform)}`;
        const detailed = stderrTail === '' ? message : `${message}. stderr: ${stderrTail}`;
        reject(new BrowserInstallError(detailed, stderrTail));
      };

      let child: InstallerProcess;
      try {
        /* Без --no-shell: тихий вход запускает headless-оболочку, и ставить надо и её */
        child = spawnInstaller(process.execPath, [cliPath, 'install', 'chromium']);
      } catch (error) {
        fail(`процесс установки не запустился (${error instanceof Error ? error.message : String(error)})`);
        return;
      }
      this.child = child;

      const timer = setTimeout(() => {
        if (finished) {
          return;
        }
        finished = true;
        this.terminate(child);
        fail(`установка не уложилась в ${timeoutMs} мс`);
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer | string) => {
        const text = partialLine + chunk.toString();
        const lastBreak = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r'));
        partialLine = text.slice(lastBreak + 1);
        this.readProgress(text.slice(0, lastBreak + 1));
      });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_LENGTH);
      });

      child.on('error', (error) => {
        if (finished) {
          return;
        }
        finished = true;
        clearTimeout(timer);
        fail(`процесс установки не запустился (${error.message})`);
      });

      child.on('close', (code, signal) => {
        if (this.child === child) {
          this.child = undefined;
        }
        if (finished) {
          return;
        }
        finished = true;
        clearTimeout(timer);
        this.readProgress(partialLine);
        const executableExists = this.options.executableExists ?? chromiumExecutablesExist;
        if (code === 0 && executableExists() === false) {
          fail('установщик завершился успешно, но нужных входу сборок на диске нет');
          return;
        }
        if (code === 0) {
          logger.info('Chromium установлен');
          resolve();
          return;
        }
        fail(`установщик завершился с кодом ${code ?? 'нет'}${signal !== null ? `, сигнал ${signal}` : ''}`);
      });
    });
  }
}

/** Команда ручной установки для текущей версии; версия обязательна, без неё ставится чужая ревизия */
function currentInstallHint(): string {
  try {
    return manualInstallHint(playwrightVersion(), process.platform);
  } catch {
    return 'Версию playwright прочитать не удалось: переустановите сервер';
  }
}

/**
 * Отказ браузера в форму отказа авторизации. Единственный источник текста: инструмент
 * получает причину и команду ручной установки, а не сырую ошибку Playwright.
 */
export function browserUnavailable(cause: unknown): AuthError {
  let reason: string;
  if (isMissingExecutableError(cause)) {
    reason = `сборка Chromium не найдена. ${currentInstallHint()}`;
  } else if (cause instanceof Error) {
    reason = cause.message;
  } else {
    reason = String(cause);
  }
  return new AuthError(`Браузер для входа недоступен: ${reason}`, 'protocol', { cause });
}

/** Ответ инструмента, пока идёт установка: не ошибка, а состояние с подсказкой, что делать */
export interface BrowserInstallInProgress {
  status: 'browser_install_in_progress';
  /** Процент загрузки; null, пока установщик не прислал ни одной строки прогресса */
  percent: number | null;
  total: string | null;
  next_step: string;
}

const INSTALL_IN_PROGRESS_NEXT_STEP =
  'сервер скачивает браузер для входа (около 150 МБ), это происходит один раз: ' +
  'повторите вызов через несколько минут';

export function browserInstallInProgress(progress: InstallProgress | undefined): BrowserInstallInProgress {
  return {
    status: 'browser_install_in_progress',
    percent: progress?.percent ?? null,
    total: progress?.total ?? null,
    next_step: INSTALL_IN_PROGRESS_NEXT_STEP,
  };
}
