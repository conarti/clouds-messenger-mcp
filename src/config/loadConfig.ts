import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CONFIG_FILE_ENV,
  DEFAULT_AUTH,
  DEFAULT_DOWNLOADS,
  DEFAULT_LIMITS,
  DEFAULT_PROTOCOL,
  DEFAULT_WS,
  defaultPaths,
} from './defaults.js';
import type { Config, ConfigOverrides } from './types.js';

/**
 * Путь файла конфига. Переменная окружения существует ради тестов и нестандартных
 * установок: без неё загрузка всегда смотрит в один и тот же файл в домашнем каталоге.
 */
export function resolveConfigFile(): string {
  const fromEnv = process.env[CONFIG_FILE_ENV];
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return resolve(fromEnv);
  }
  return defaultPaths().configFile;
}

function readConfigFile(configFile: string): ConfigOverrides {
  let raw: string;
  try {
    raw = readFileSync(configFile, 'utf8');
  } catch (error) {
    /* Отсутствие файла это штатный случай: работаем на дефолтах */
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw new Error(`Не удалось прочитать config: ${configFile}: ${(error as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`config содержит невалидный JSON: ${configFile}: ${(error as Error).message}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`config должен быть JSON-объектом: ${configFile}`);
  }

  return parsed as ConfigOverrides;
}

/**
 * Три источника, приоритет по возрастанию: дефолты, файл, программный аргумент.
 * Слияние поточечное внутри секции: частичный файл не обнуляет соседние поля секции.
 */
export function loadConfig(overrides: ConfigOverrides = {}): Config {
  const configFile = resolveConfigFile();
  const fromFile = readConfigFile(configFile);

  return {
    protocol: { ...DEFAULT_PROTOCOL, ...fromFile.protocol, ...overrides.protocol },
    /*
     * `configFile` идёт последним намеренно: поле отчитывается о том, какой файл
     * действительно прочитан, и содержимое самого файла это переписать не вправе.
     */
    paths: { ...defaultPaths(), ...fromFile.paths, ...overrides.paths, configFile },
    downloads: { ...DEFAULT_DOWNLOADS, ...fromFile.downloads, ...overrides.downloads },
    limits: { ...DEFAULT_LIMITS, ...fromFile.limits, ...overrides.limits },
    auth: { ...DEFAULT_AUTH, ...fromFile.auth, ...overrides.auth },
    ws: { ...DEFAULT_WS, ...fromFile.ws, ...overrides.ws },
  };
}
