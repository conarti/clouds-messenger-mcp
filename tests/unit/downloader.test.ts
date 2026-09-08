/**
 * Загрузчик вложений.
 *
 * Файловая система настоящая (временный каталог), подменён только fetch: проверять надо
 * ровно то, что подложный fs не воспроизводит, то есть запись, коллизию имён и обрывок
 * файла после отказа.
 *
 * Форма запроса взята из бандла веб-клиента и живьём не проверялась, поэтому проверка
 * фиксирует её ДОСЛОВНО: адрес, заголовки и параметр key_id. Когда живая проба состоится,
 * расхождение обнаружится здесь, а не в чужом каталоге загрузок.
 */
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthError } from '../../src/auth/AuthProvider.js';
import { FakeAuthProvider } from '../../src/auth/FakeAuthProvider.js';
import {
  buildAttachmentUrl,
  downloadAttachment,
  sanitizeFileName,
  type DownloaderDeps,
} from '../../src/attachments/downloader.js';
import type { Attachment } from '../../src/protocol/attachments.js';
import { MessengerError } from '../../src/protocol/errors.js';
import { createLogger } from '../../src/util/logger.js';
import { createTestConfig } from '../helpers/testConfig.js';
import { POLYGON_CHAT_ID } from '../helpers/readFixtures.js';

const FILE_ID = 'c0ffee00-0000-4000-8000-000000000001';
const FILE_BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
const logger = createLogger({ level: 'error' });

interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
}

let downloadsDir: string;
let requests: RecordedRequest[];

const attachment: Attachment = {
  file_id: FILE_ID,
  file_name: 'снимок.png',
  file_mime_type: 'image/png',
  file_encryption_algo: 'stream',
  has_preview: true,
};

/** Подложный fetch: отдаёт заранее назначенные ответы по порядку вызовов */
function stubFetch(responses: Array<() => Response>): typeof fetch {
  let index = 0;
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>),
    );
    requests.push({ url: String(input), headers });
    const make = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (make === undefined) {
      throw new Error('подложный fetch: ответы кончились');
    }
    return make();
  }) as typeof fetch;
}

function createDeps(options: {
  responses: Array<() => Response>;
  maxFileSizeBytes?: number;
  ttlDays?: number;
}): DownloaderDeps & { auth: FakeAuthProvider } {
  const auth = new FakeAuthProvider();
  return {
    auth,
    config: createTestConfig({
      paths: { downloadsDir },
      downloads: {
        ttlDays: options.ttlDays ?? 7,
        maxFileSizeBytes: options.maxFileSizeBytes ?? 1024,
      },
    }),
    logger,
    fetchImplementation: stubFetch(options.responses),
  };
}

const okResponse = (): Response =>
  new Response(FILE_BYTES, { status: 200, headers: { 'content-type': 'application/octet-stream' } });

beforeEach(async () => {
  downloadsDir = await mkdtemp(join(tmpdir(), 'clouds-downloader-'));
  requests = [];
});

afterEach(async () => {
  await rm(downloadsDir, { recursive: true, force: true });
});

describe('sanitizeFileName', () => {
  it('схлопывает разделители пути: имя из переписки не уводит запись наружу', () => {
    expect(sanitizeFileName('a/b\\c.png')).toBe('a_b_c.png');
    /*
     * Обход каталогов умирает вместе с разделителем: без него точки безобидны, поэтому
     * проверяется отсутствие разделителя и ведущей точки, а не отсутствие точек вообще.
     */
    expect(sanitizeFileName('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(sanitizeFileName('..\\..\\windows')).not.toContain('\\');
  });

  it('срезает ведущие точки и управляющие символы', () => {
    expect(sanitizeFileName('.bashrc')).toBe('bashrc');
    expect(sanitizeFileName('имя\u0007со звонком.txt')).toBe('имясо звонком.txt');
  });

  it('пустое имя заменяется запасным, длинное обрезается с сохранением расширения', () => {
    expect(sanitizeFileName(undefined)).toBe('attachment');
    expect(sanitizeFileName('   ')).toBe('attachment');

    const long = sanitizeFileName(`${'я'.repeat(300)}.png`);
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.endsWith('.png')).toBe(true);
  });
});

describe('buildAttachmentUrl', () => {
  it('собирает адрес файловой службы из базы, чата и файла', () => {
    const url = buildAttachmentUrl({
      restBaseUrl: 'https://example.test/api',
      fileServicePath: '/v2/file_service/files/groupchat_file/',
      chatId: POLYGON_CHAT_ID,
      fileId: FILE_ID,
      keyId: 'key-id-1',
    });

    expect(url).toBe(
      `https://example.test/api/v2/file_service/files/groupchat_file/${POLYGON_CHAT_ID}/${FILE_ID}?key_id=key-id-1`,
    );
  });
});

describe('downloadAttachment', () => {
  it('кладёт байты на диск и отдаёт путь, размер и признак шифрования', async () => {
    const deps = createDeps({ responses: [okResponse] });

    const result = await downloadAttachment(deps, { attachment, chatId: POLYGON_CHAT_ID });

    expect(result.size).toBe(FILE_BYTES.byteLength);
    expect(result.file_name).toBe(`${FILE_ID}-снимок.png`);
    expect(result.mime_type).toBe('image/png');
    /* Потоковый шифр не снимается: на диске лежит ровно то, что отдал сервер */
    expect(result.encrypted).toBe(true);
    expect(new Uint8Array(await readFile(result.path))).toEqual(FILE_BYTES);
    expect(result.path.startsWith(join(downloadsDir, POLYGON_CHAT_ID))).toBe(true);
  });

  it('идёт по адресу из бандла и несёт bearer, cookie и узнаваемый User-Agent', async () => {
    const deps = createDeps({ responses: [okResponse] });

    await downloadAttachment(deps, { attachment, chatId: POLYGON_CHAT_ID });

    const request = requests[0];
    expect(request?.url).toContain(deps.config.protocol.fileServicePath);
    expect(request?.url).toContain(`${POLYGON_CHAT_ID}/${FILE_ID}`);
    expect(request?.url).toContain(`key_id=${deps.auth.keyMaterial.wsParams.keyId}`);
    expect(request?.headers['Authorization']).toBe(`Bearer ${deps.auth.bearer}`);
    expect(request?.headers['Cookie']).toBe(deps.auth.cookieHeader);
    expect(request?.headers['User-Agent']).toBe(deps.config.protocol.userAgent);
  });

  it('файл без объявленного алгоритма шифрования пометки encrypted не получает', async () => {
    const deps = createDeps({ responses: [okResponse] });
    const plain: Attachment = { file_id: FILE_ID, file_name: 'заметка.txt', has_preview: false };

    const result = await downloadAttachment(deps, { attachment: plain, chatId: POLYGON_CHAT_ID });

    expect(result.encrypted).toBe(false);
  });

  it('повтор кладёт копию рядом, а не затирает прежний файл', async () => {
    const deps = createDeps({ responses: [okResponse] });

    const first = await downloadAttachment(deps, { attachment, chatId: POLYGON_CHAT_ID });
    const second = await downloadAttachment(deps, { attachment, chatId: POLYGON_CHAT_ID });

    expect(second.path).not.toBe(first.path);
    expect(await readdir(join(downloadsDir, POLYGON_CHAT_ID))).toHaveLength(2);
  });

  it('адрес чата не по образцу протокола это отказ без запроса и без записи', async () => {
    const deps = createDeps({ responses: [okResponse] });

    await expect(
      downloadAttachment(deps, { attachment, chatId: '../evil' }),
    ).rejects.toBeInstanceOf(MessengerError);

    /* Ни сети, ни диска: отказ случился до того, как путь вообще собрался */
    expect(requests).toEqual([]);
    expect(await readdir(downloadsDir)).toEqual([]);
  });

  it('протухший bearer это повод обновиться и повторить ровно один раз', async () => {
    const deps = createDeps({
      responses: [() => new Response('', { status: 401 }), okResponse],
    });

    const result = await downloadAttachment(deps, { attachment, chatId: POLYGON_CHAT_ID });

    expect(result.size).toBe(FILE_BYTES.byteLength);
    expect(deps.auth.calls.onAuthFailure).toBe(1);
    expect(requests).toHaveLength(2);
  });

  it('второй отказ авторизации уходит наверх: дело уже не в сроке жизни токена', async () => {
    const deps = createDeps({ responses: [() => new Response('', { status: 401 })] });

    await expect(
      downloadAttachment(deps, { attachment, chatId: POLYGON_CHAT_ID }),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it('отказ сервера не превращается в пустой файл', async () => {
    const deps = createDeps({ responses: [() => new Response('нет такого файла', { status: 404 })] });

    const failure = await downloadAttachment(deps, {
      attachment,
      chatId: POLYGON_CHAT_ID,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MessengerError);
    expect((failure as MessengerError).layer).toBe('rest');
    expect((failure as MessengerError).code).toBe('404');
    await expect(readdir(join(downloadsDir, POLYGON_CHAT_ID))).rejects.toThrow();
  });

  it('заявленный размер сверх потолка отсекается до запроса', async () => {
    const deps = createDeps({ responses: [okResponse], maxFileSizeBytes: 4 });
    const huge: Attachment = { ...attachment, file_size: 1_000_000 };

    await expect(
      downloadAttachment(deps, { attachment: huge, chatId: POLYGON_CHAT_ID }),
    ).rejects.toBeInstanceOf(MessengerError);
    expect(requests).toHaveLength(0);
  });

  it('фактический размер сверх потолка обрывает запись и убирает обрывок', async () => {
    const deps = createDeps({ responses: [okResponse], maxFileSizeBytes: 4 });

    await expect(
      downloadAttachment(deps, { attachment, chatId: POLYGON_CHAT_ID }),
    ).rejects.toBeInstanceOf(MessengerError);
    expect(await readdir(join(downloadsDir, POLYGON_CHAT_ID))).toEqual([]);
  });

  it('подметает протухшие загрузки перед скачиванием, а не только на старте сервера', async () => {
    const stale = join(downloadsDir, 'протухший.bin');
    await writeFile(stale, 'старая копия чужой переписки');
    const ancient = (Date.now() - 90 * 24 * 60 * 60 * 1000) / 1000;
    await utimes(stale, ancient, ancient);
    const deps = createDeps({ responses: [okResponse] });

    await downloadAttachment(deps, { attachment, chatId: POLYGON_CHAT_ID });

    expect(await readdir(downloadsDir)).toEqual([POLYGON_CHAT_ID]);
  });
});
