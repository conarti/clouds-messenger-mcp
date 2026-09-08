/**
 * config.example.json это документация, которая устаревает молча.
 *
 * Поле, добавленное в дефолты, само в примере не появляется: пример остаётся валидным
 * JSON, загружается без ошибки и продолжает выглядеть полным, хотя полным быть перестал.
 * Поэтому пример проверяется как код, а не читается глазами: он обязан грузиться тем же
 * загрузчиком, что и пользовательский файл, и обязан нести КАЖДУЮ секцию и КАЖДОЕ поле
 * дефолтов. Проверка «пример парсится» этого не даёт: она зелена и на половине секций.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONFIG_FILE_ENV,
  DEFAULT_AUTH,
  DEFAULT_DOWNLOADS,
  DEFAULT_LIMITS,
  DEFAULT_PROTOCOL,
  DEFAULT_WS,
  defaultPaths,
} from '../../src/config/defaults.js';
import { loadConfig } from '../../src/config/loadConfig.js';

const EXAMPLE_FILE = fileURLToPath(new URL('../../config.example.json', import.meta.url));

/** Секции дефолтов ровно в том составе, в каком их собирает загрузчик */
const DEFAULT_SECTIONS = {
  protocol: DEFAULT_PROTOCOL,
  paths: defaultPaths(),
  downloads: DEFAULT_DOWNLOADS,
  limits: DEFAULT_LIMITS,
  auth: DEFAULT_AUTH,
  ws: DEFAULT_WS,
};

/**
 * Секции, значения которых не зависят от машины. Пути сюда не входят: они собираются от
 * домашнего каталога, и требовать от примера совпадения с ними значило бы требовать,
 * чтобы у читателя примера было то же имя пользователя.
 */
const MACHINE_INDEPENDENT = ['protocol', 'downloads', 'limits', 'auth', 'ws'] as const;

function readExample(): Record<string, unknown> {
  return JSON.parse(readFileSync(EXAMPLE_FILE, 'utf8')) as Record<string, unknown>;
}

function sectionOf(example: Record<string, unknown>, name: string): Record<string, unknown> | undefined {
  const value = example[name];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

beforeEach(() => {
  process.env[CONFIG_FILE_ENV] = EXAMPLE_FILE;
});

afterEach(() => {
  delete process.env[CONFIG_FILE_ENV];
});

describe('config.example.json грузится боевым загрузчиком', () => {
  it('читается без ошибок и отчитывается о фактически прочитанном файле', () => {
    const config = loadConfig();

    expect(config.paths.configFile).toBe(EXAMPLE_FILE);
    expect(config.paths.profileDir.length).toBeGreaterThan(0);
    expect(config.paths.downloadsDir.length).toBeGreaterThan(0);
  });

  it('несёт значения по умолчанию во всех машинно-независимых секциях', () => {
    const config = loadConfig();

    for (const section of MACHINE_INDEPENDENT) {
      expect(config[section]).toEqual(DEFAULT_SECTIONS[section]);
    }
  });
});

describe('config.example.json не отстаёт от дефолтов', () => {
  it('несёт каждую секцию', () => {
    const example = readExample();
    const missing = Object.keys(DEFAULT_SECTIONS).filter(
      (section) => sectionOf(example, section) === undefined,
    );

    expect(missing).toEqual([]);
  });

  it('несёт каждое поле каждой секции', () => {
    const example = readExample();
    const missing: string[] = [];

    for (const [name, defaults] of Object.entries(DEFAULT_SECTIONS)) {
      const section = sectionOf(example, name);
      if (section === undefined) {
        missing.push(name);
        continue;
      }
      for (const field of Object.keys(defaults)) {
        if (!Object.hasOwn(section, field)) {
          missing.push(`${name}.${field}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });
});

describe('config.example.json объясняет себя', () => {
  it('несёт пояснение в поле $comment', () => {
    expect(typeof readExample()['$comment']).toBe('string');
  });

  it('задаёт пути абсолютными: относительный путь загрузчик не резолвит', () => {
    const paths = sectionOf(readExample(), 'paths') ?? {};
    const notAbsolute = Object.entries(paths).filter(
      ([, value]) => typeof value !== 'string' || !isAbsolute(value),
    );

    expect(notAbsolute).toEqual([]);
  });
});
