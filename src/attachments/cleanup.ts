/**
 * TTL-подметание каталога загрузок.
 *
 * ЗАЧЕМ. Скачанное вложение это копия чужой переписки на диске. Она не должна жить вечно
 * только потому, что агент один раз её открыл, поэтому срок жизни копии ограничен
 * `downloads.ttlDays`, а подметание идёт без участия человека: на старте сервера и перед
 * каждым скачиванием. Второе важнее первого: сервер MCP может не перезапускаться неделями,
 * и старт как единственная точка подметания не сработал бы ни разу.
 *
 * ГЛУБИНА РОВНО ОДИН УРОВЕНЬ. Загрузки разложены по каталогам чатов, поэтому подметание
 * смотрит и в корень, и в каталоги первого уровня, но НЕ спускается глубже и НЕ ходит по
 * символическим ссылкам: ссылка в этой папке указывала бы наружу, а подметание не имеет
 * права трогать ничего за её пределами.
 *
 * ГИГИЕНА, А НЕ ТРАНЗАКЦИЯ. Отказ на одном файле не прекращает проход: из-за одного
 * занятого файла остальные протухшие копии оставаться на диске не должны.
 */
import { lstat, readdir, rmdir, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Logger } from '../util/logger.js';

const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;

export interface SweepOptions {
  /** Абсолютный путь каталога загрузок (`config.paths.downloadsDir`) */
  downloadsDir: string;
  /** `downloads.ttlDays`. Значение не больше нуля ВЫКЛЮЧАЕТ подметание, а не стирает всё */
  ttlDays: number;
  /** Точка отсчёта в миллисекундах. Подменяется в тестах */
  now?: number;
  logger?: Logger;
}

export interface SweepResult {
  removed: number;
  kept: number;
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** Только обычные файлы и только внутри своего каталога: за границу подметание не выходит */
async function sweepFile(path: string, directory: string, deadline: number): Promise<boolean> {
  if (dirname(path) !== directory) {
    return false;
  }
  const stats = await lstat(path);
  if (!stats.isFile() || stats.mtimeMs >= deadline) {
    return false;
  }
  await unlink(path);
  return true;
}

/** Имена каталога в лог не попадают: каталог назван идентификатором чата, а файл именем вложения */
async function sweepDirectory(
  directory: string,
  deadline: number,
  logger: Logger | undefined,
): Promise<SweepResult & { entries: number }> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (isNotFound(error)) {
      return { removed: 0, kept: 0, entries: 0 };
    }
    throw error;
  }

  let removed = 0;
  let kept = 0;
  let remaining = entries.length;

  for (const entry of entries) {
    const path = join(directory, entry);
    try {
      if (await sweepFile(path, directory, deadline)) {
        removed += 1;
        remaining -= 1;
      } else {
        kept += 1;
      }
    } catch (error) {
      if (isNotFound(error)) {
        remaining -= 1;
        continue;
      }
      /*
       * В лог идёт только errno: и текст ошибки, и имя записи несут путь, а имя вложения
       * это часть чужой переписки.
       */
      logger?.warn('подметание загрузок: запись не удалена', {
        code: (error as NodeJS.ErrnoException).code ?? 'unknown',
      });
      kept += 1;
    }
  }

  return { removed, kept, entries: remaining };
}

/**
 * Удаляет файлы старше TTL из каталога загрузок и из каталогов чатов внутри него.
 *
 * Отсутствие каталога это штатный случай (ещё ничего не качали), а не ошибка: подметание
 * зовут до первого скачивания, и падать на пустом месте оно не имеет права.
 */
export async function sweepDownloads(options: SweepOptions): Promise<SweepResult> {
  const { ttlDays, logger } = options;
  const now = options.now ?? Date.now();

  /* Ноль и отрицательное это «выключено»: иначе конфиг с опечаткой стёр бы всю папку разом */
  if (!Number.isFinite(ttlDays) || ttlDays <= 0) {
    logger?.debug('подметание загрузок пропущено: ttlDays выключает его', { ttlDays });
    return { removed: 0, kept: 0 };
  }

  const root = resolve(options.downloadsDir);
  const deadline = now - ttlDays * MILLIS_PER_DAY;

  let rootEntries: string[];
  try {
    rootEntries = await readdir(root);
  } catch (error) {
    if (isNotFound(error)) {
      return { removed: 0, kept: 0 };
    }
    throw error;
  }

  let removed = 0;
  let kept = 0;

  for (const entry of rootEntries) {
    const path = join(root, entry);
    try {
      const stats = await lstat(path);
      if (stats.isFile()) {
        if (await sweepFile(path, root, deadline)) {
          removed += 1;
        } else {
          kept += 1;
        }
        continue;
      }
      if (!stats.isDirectory()) {
        /* Символическая ссылка и всё прочее не наше: за ней может быть что угодно */
        continue;
      }
      const nested = await sweepDirectory(path, deadline, logger);
      removed += nested.removed;
      kept += nested.kept;
      if (nested.entries === 0) {
        /* Опустевший каталог чата не оставляем: он и сам по себе говорит, с кем была переписка */
        await rmdir(path).catch(() => undefined);
      }
    } catch (error) {
      if (isNotFound(error)) {
        continue;
      }
      logger?.warn('подметание загрузок: запись не удалена', {
        code: (error as NodeJS.ErrnoException).code ?? 'unknown',
      });
    }
  }

  logger?.debug('подметание загрузок завершено', { removed, kept, ttlDays });
  return { removed, kept };
}
