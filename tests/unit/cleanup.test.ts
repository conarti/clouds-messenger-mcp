/**
 * TTL-подметание каталога загрузок.
 *
 * Проверка работает на НАСТОЯЩЕЙ файловой системе во временном каталоге: подметание это
 * ровно про поведение файловой системы (время правки, каталоги, отсутствие каталога), и
 * на подложном модуле fs оно доказывало бы только устройство подложного модуля.
 */
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sweepDownloads } from '../../src/attachments/cleanup.js';
import { createLogger } from '../../src/util/logger.js';

const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 8, 12, 0, 0);
const logger = createLogger({ level: 'error' });

let root: string;

/** Файл с заданным возрастом в днях: время правки и есть то, по чему судит подметание */
async function makeFile(path: string, ageDays: number): Promise<void> {
  await writeFile(path, 'содержимое вложения');
  const seconds = (NOW - ageDays * MILLIS_PER_DAY) / 1000;
  await utimes(path, seconds, seconds);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'clouds-downloads-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('sweepDownloads', () => {
  it('удаляет файлы старше TTL и оставляет свежие', async () => {
    await makeFile(join(root, 'старый.bin'), 9);
    await makeFile(join(root, 'свежий.bin'), 1);

    const result = await sweepDownloads({ downloadsDir: root, ttlDays: 7, now: NOW, logger });

    expect(result).toEqual({ removed: 1, kept: 1 });
    expect(await readdir(root)).toEqual(['свежий.bin']);
  });

  it('спускается в каталоги чатов и убирает опустевший каталог', async () => {
    const chatDirectory = join(root, '11111111-2222-4333-8444-555555555555');
    const liveDirectory = join(root, '22222222-3333-4444-8555-666666666666');
    await mkdir(chatDirectory);
    await mkdir(liveDirectory);
    await makeFile(join(chatDirectory, 'старый.bin'), 30);
    await makeFile(join(liveDirectory, 'старый.bin'), 30);
    await makeFile(join(liveDirectory, 'свежий.bin'), 0);

    const result = await sweepDownloads({ downloadsDir: root, ttlDays: 7, now: NOW, logger });

    expect(result.removed).toBe(2);
    expect(result.kept).toBe(1);
    expect(await readdir(root)).toEqual(['22222222-3333-4444-8555-666666666666']);
    expect(await readdir(liveDirectory)).toEqual(['свежий.bin']);
  });

  it('отсутствие каталога это штатный случай, а не ошибка', async () => {
    const missing = join(root, 'ещё-ничего-не-качали');

    await expect(sweepDownloads({ downloadsDir: missing, ttlDays: 7, now: NOW, logger })).resolves.toEqual(
      { removed: 0, kept: 0 },
    );
  });

  it('нулевой и отрицательный TTL выключают подметание, а не стирают всё', async () => {
    await makeFile(join(root, 'древний.bin'), 400);

    expect(await sweepDownloads({ downloadsDir: root, ttlDays: 0, now: NOW, logger })).toEqual({
      removed: 0,
      kept: 0,
    });
    expect(await sweepDownloads({ downloadsDir: root, ttlDays: -1, now: NOW, logger })).toEqual({
      removed: 0,
      kept: 0,
    });
    expect(await readdir(root)).toEqual(['древний.bin']);
  });

  it('глубже одного уровня не спускается: вложенный каталог остаётся нетронутым', async () => {
    const chatDirectory = join(root, 'чат');
    const deeper = join(chatDirectory, 'глубже');
    await mkdir(deeper, { recursive: true });
    await makeFile(join(deeper, 'старый.bin'), 30);

    const result = await sweepDownloads({ downloadsDir: root, ttlDays: 7, now: NOW, logger });

    expect(result.removed).toBe(0);
    expect(await readdir(deeper)).toEqual(['старый.bin']);
  });
});
