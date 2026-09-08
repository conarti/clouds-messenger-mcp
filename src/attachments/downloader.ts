/**
 * Скачивание вложения на диск.
 *
 * ФОРМА ЗАПРОСА ИЗ БАНДЛА ВЕБ-КЛИЕНТА, ЖИВЬЁМ НЕ ПРОВЕРЕНА. В бандле найдена сборка адреса
 * файловой службы: `GET https://<host>/api/v2/file_service/files/groupchat_file/<chat_id>/<file_id>?key_id=<...>`
 * с заголовком `Authorization: Bearer`. Путь вынесен в конфиг (`protocol.fileServicePath`),
 * потому что версия API дрейфует вместе с релизами клиента.
 *
 * КАКОЙ ИМЕННО `key_id` ЖДЁТ ФАЙЛОВАЯ СЛУЖБА, НЕ УСТАНОВЛЕНО. В бандле это отдельный
 * параметр, не совпадающий с `sender_key_id` события. Здесь подставляется идентификатор
 * ключа сессии, тот же, что уходит в query сокета: другого идентификатора у клиента на
 * руках нет. Это часть объявленной неполноты инструмента, а не установленный факт.
 *
 * ФАЙЛ НЕ РАСШИФРОВЫВАЕТСЯ, И ЭТО ОСОЗНАННО. Из бандла видно, что файл шифруется потоковым
 * шифром libsodium (`file_encryption_algo: "stream"`), ключ приезжает тем же конвертом, что
 * и тело события, а поток нарезан на куски по `chunk_size` плюс тег. Ни разметка потока, ни
 * содержимое заголовка живой пробой не проверялись, живого файла для сверки нет, и молча
 * записанный на диск испорченный файл хуже честного шифротекста. Поэтому байты кладутся как
 * есть, а выдача несёт `encrypted: true`.
 *
 * ПОТОЛОК РАЗМЕРА ОБЯЗАТЕЛЕН. Заявленный размер приезжает из чужого сообщения, а реальная
 * длина ответа не обязана ему соответствовать, поэтому проверяются обе: заявленная до
 * запроса и фактическая по ходу записи.
 */
import { mkdir, open, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { AuthError, type AuthProvider } from '../auth/AuthProvider.js';
import type { Config } from '../config/types.js';
import type { Attachment } from '../protocol/attachments.js';
import { MessengerError } from '../protocol/errors.js';
import type { Logger } from '../util/logger.js';
import { sweepDownloads } from './cleanup.js';

/** Потолок длины имени: у файловых систем предел около 255 байт, оставляем запас под суффикс */
const MAX_NAME_LENGTH = 120;
/** Сколько суффиксов перебирается, прежде чем имя признаётся неподбираемым */
const MAX_COLLISION_ATTEMPTS = 100;

export interface DownloaderDeps {
  auth: AuthProvider;
  config: Config;
  logger: Logger;
  /** Подменяется в тестах; по умолчанию глобальный fetch рантайма */
  fetchImplementation?: typeof fetch;
}

export interface DownloadAttachmentInput {
  attachment: Attachment;
  /** Чат, в котором лежит сообщение: он участвует и в адресе, и в раскладке на диске */
  chatId: string;
}

export interface DownloadedAttachment {
  /** Абсолютный путь: потребитель читает файл по нему */
  path: string;
  /** Имя НА ДИСКЕ: оно очищено от разделителей пути и потому может отличаться от имени в чате */
  file_name: string;
  size: number;
  mime_type?: string;
  /** Файл сохранён как приехал, потоковый шифр не снят */
  encrypted: boolean;
}

/**
 * Приводит имя к безопасному для файловой системы виду.
 *
 * ЗАДАЧА НЕ КРАСОТА, А ГРАНИЦА: имя приходит из чужой переписки и не имеет права вывести
 * запись за пределы каталога загрузок. Разделители схлопываются, ведущие точки срезаются,
 * и `..` перестаёт существовать как класс.
 */
export function sanitizeFileName(rawName: string | undefined): string {
  const cleaned = (rawName ?? '')
    .normalize('NFC')
    /* Управляющие символы: мусор в имени и заодно инъекция в терминал того, кто его покажет */
    .replace(/[\u0000-\u001f\u007f]/g, '')
    /* Оба разделителя, включая обратный: путь в имени становится невозможен */
    .replace(/[/\\]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  if (cleaned.length === 0) {
    return 'attachment';
  }
  if (cleaned.length <= MAX_NAME_LENGTH) {
    return cleaned;
  }
  /* Расширение сохраняется: по нему потребитель понимает, что за файл у него на руках */
  const extension = extname(cleaned).slice(0, 16);
  return `${cleaned.slice(0, MAX_NAME_LENGTH - extension.length)}${extension}`;
}

/** Адрес файловой службы. Сегменты экранируются поштучно, чтобы разделитель пути уцелел */
export function buildAttachmentUrl(input: {
  restBaseUrl: string;
  fileServicePath: string;
  chatId: string;
  fileId: string;
  keyId: string;
}): string {
  const url = new URL(
    `${input.restBaseUrl}${input.fileServicePath}${encodeURIComponent(input.chatId)}/${encodeURIComponent(input.fileId)}`,
  );
  url.searchParams.set('key_id', input.keyId);
  return url.toString();
}

/** Открывает файл, не затирая существующий: повтор скачивания кладёт копию, а не портит старую */
async function openWithoutOverwrite(
  directory: string,
  name: string,
): Promise<{ handle: FileHandle; path: string }> {
  const extension = extname(name);
  const stem = basename(name, extension);
  for (let attempt = 0; attempt < MAX_COLLISION_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 0 ? name : `${stem}-${attempt}${extension}`;
    const path = join(directory, candidate);
    /* Последний рубеж: после очистки имя не может увести наружу, но проверка стоит здесь */
    if (dirname(path) !== directory) {
      throw new MessengerError({
        layer: 'client',
        code: 'attachment_path',
        detail: 'имя вложения выводит запись за пределы каталога загрузок',
      });
    }
    try {
      return { handle: await open(path, 'wx'), path };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
  }
  throw new MessengerError({
    layer: 'client',
    code: 'attachment_path',
    detail: `свободное имя не подобралось за ${MAX_COLLISION_ATTEMPTS} попыток`,
  });
}

function tooLarge(limit: number, actual: number): MessengerError {
  return new MessengerError({
    layer: 'client',
    code: 'attachment_too_large',
    detail: `размер ${actual} байт превышает потолок ${limit} байт (downloads.maxFileSizeBytes)`,
  });
}

/** Пишет тело ответа на диск по кускам, считая байты: весь файл в память не поднимается */
async function writeBody(
  response: Response,
  handle: FileHandle,
  limitBytes: number,
): Promise<number> {
  const body = response.body;
  if (body === null) {
    /* Ответ без потока: подложные реализации в тестах и пустое тело у сервера */
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > limitBytes) {
      throw tooLarge(limitBytes, buffer.byteLength);
    }
    await handle.write(buffer);
    return buffer.byteLength;
  }

  const reader = body.getReader();
  let written = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done === true) {
      break;
    }
    const bytes = chunk.value;
    written += bytes.byteLength;
    if (written > limitBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge(limitBytes, written);
    }
    await handle.write(bytes);
  }
  return written;
}

/**
 * Один повтор на отвергнутом bearer: протухший токен не должен выглядеть как «файла нет».
 * Второй отказ уходит наверх как отказ авторизации, потому что дело уже не в сроке жизни.
 */
async function fetchAttachment(
  deps: DownloaderDeps,
  url: string,
  doFetch: typeof fetch,
): Promise<Response> {
  const request = async (): Promise<Response> => {
    const [bearer, cookieHeader] = await Promise.all([
      deps.auth.getBearer(),
      deps.auth.getCookieHeader(),
    ]);
    return doFetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${bearer}`,
        Cookie: cookieHeader,
        Accept: '*/*',
        'User-Agent': deps.config.protocol.userAgent,
      },
    });
  };

  const response = await request();
  if (response.status !== 401) {
    return response;
  }
  deps.logger.warn('файловая служба отвергла bearer, сброс кэша авторизации и один повтор');
  await deps.auth.onAuthFailure();
  const retried = await request();
  if (retried.status === 401) {
    throw new AuthError('файловая служба отвергла bearer (HTTP 401) даже после обновления', 'bearer');
  }
  return retried;
}

/**
 * Качает вложение и возвращает путь на диске.
 *
 * Подметание идёт ПЕРЕД каждым скачиванием, а не только на старте сервера: процесс MCP
 * может жить неделями без перезапуска, и старт как единственная точка подметания оставил бы
 * копии чужой переписки на диске навсегда.
 */
export async function downloadAttachment(
  deps: DownloaderDeps,
  input: DownloadAttachmentInput,
): Promise<DownloadedAttachment> {
  const { config, logger } = deps;
  const doFetch = deps.fetchImplementation ?? globalThis.fetch;
  const limitBytes = config.downloads.maxFileSizeBytes;
  const declaredSize = input.attachment.file_size;

  if (declaredSize !== undefined && declaredSize > limitBytes) {
    throw tooLarge(limitBytes, declaredSize);
  }

  await sweepDownloads({
    downloadsDir: config.paths.downloadsDir,
    ttlDays: config.downloads.ttlDays,
    logger,
  });

  const keyMaterial = await deps.auth.getKeyMaterial();
  const url = buildAttachmentUrl({
    restBaseUrl: config.protocol.restBaseUrl,
    fileServicePath: config.protocol.fileServicePath,
    chatId: input.chatId,
    fileId: input.attachment.file_id,
    keyId: keyMaterial.wsParams.keyId,
  });

  const response = await fetchAttachment(deps, url, doFetch);
  if (!response.ok) {
    /*
     * Отказ не приукрашивается и не превращается в пустой успех: пустой файл на диске
     * невозможно отличить от настоящего, а внятный отказ можно починить.
     */
    throw new MessengerError({
      layer: 'rest',
      code: String(response.status),
      detail: 'файловая служба не отдала вложение',
    });
  }

  /* Имя из сообщения авторитетнее заголовков: заголовки этой ручки живьём не наблюдались */
  const directory = join(resolve(config.paths.downloadsDir), input.chatId);
  await mkdir(directory, { recursive: true });
  const name = `${input.attachment.file_id}-${sanitizeFileName(input.attachment.file_name)}`;
  const { handle, path } = await openWithoutOverwrite(directory, name);

  let size: number;
  try {
    size = await writeBody(response, handle, limitBytes);
  } catch (error) {
    await handle.close();
    /* Обрывок файла на диске хуже его отсутствия: по нему нельзя понять, что он неполон */
    await unlink(path).catch(() => undefined);
    throw error;
  }
  await handle.close();

  const mimeType = input.attachment.file_mime_type ?? response.headers.get('content-type') ?? undefined;

  /* Ни имени файла, ни пути в лог: и то, и другое часть чужой переписки */
  logger.debug('вложение скачано', { chatId: input.chatId, size });

  return {
    path,
    file_name: basename(path),
    size,
    ...(mimeType !== undefined ? { mime_type: mimeType } : {}),
    encrypted: input.attachment.file_encryption_algo !== undefined,
  };
}
