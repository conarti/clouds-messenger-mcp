/**
 * `download_attachment` от кадра до файла на диске.
 *
 * Каталог загрузок настоящий (временный), файловая служба подменена: живой пробы у неё нет
 * (findings.md, P2), и проверка фиксирует ровно то, что мы утверждаем, а не то, во что
 * верим. Расшифровка сообщения при этом боевая: ссылка на файл лежит в зашифрованном теле,
 * и без настоящего крипто до неё не добраться.
 */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sodium from 'libsodium-wrappers-sumo';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DownloadAttachmentResult } from '../../src/mcp/tools/downloadAttachment.js';
import { EVENT_INFO_EVENT } from '../../src/protocol/eventInfo.js';
import { EVENTS_HISTORY_EVENT } from '../../src/protocol/history.js';
import { makeKeyRing, type KeyRing } from '../helpers/cryptoFixtures.js';
import {
  MY_HUID,
  POLYGON_CHAT_ID,
  makeHistoryEvent,
  makeInnerImage,
  makeInnerText,
  makeRawChat,
  syncId,
} from '../helpers/readFixtures.js';
import { startToolServer, type ToolServer } from '../helpers/toolServer.js';

const CHATS = [makeRawChat({ chatId: POLYGON_CHAT_ID, name: 'Избранное', chatType: 'notes' })];
const FILE_ID = 'c0ffee00-0000-4000-8000-000000000001';
const FILE_BYTES = new Uint8Array([9, 8, 7, 6, 5]);

let ring: KeyRing;
let server: ToolServer;
let downloadsDir: string;
let historyEvents: Record<string, unknown>[];
let fileServiceStatus: number;
let fileServiceCalls: string[];

async function buildHistory(): Promise<Record<string, unknown>[]> {
  const common = {
    groupChatId: POLYGON_CHAT_ID,
    sender: MY_HUID,
    senderKeyId: ring.sender.keyId,
    senderPrivateKey: ring.sender.privateKey,
    recipient: ring.recipients[0],
  };
  return [
    await makeHistoryEvent({
      ...common,
      syncId: syncId(1),
      insertedAt: '2026-09-08T07:01:00.000Z',
      inner: makeInnerText({
        msgId: syncId(1),
        from: MY_HUID,
        timestamp: '2026-09-08T07:01:00.000Z',
        groupChatId: POLYGON_CHAT_ID,
        body: 'сообщение без вложений',
      }),
    }),
    await makeHistoryEvent({
      ...common,
      syncId: syncId(2),
      insertedAt: '2026-09-08T07:02:00.000Z',
      inner: makeInnerImage({
        msgId: syncId(2),
        from: MY_HUID,
        timestamp: '2026-09-08T07:02:00.000Z',
        groupChatId: POLYGON_CHAT_ID,
        fileId: FILE_ID,
        fileName: 'снимок.png',
      }),
    }),
  ];
}

beforeAll(async () => {
  await sodium.ready;
  ring = await makeKeyRing();
});

beforeEach(async () => {
  downloadsDir = await mkdtemp(join(tmpdir(), 'clouds-tool-downloads-'));
  fileServiceStatus = 200;
  fileServiceCalls = [];
  historyEvents = await buildHistory();
  server = await startToolServer({ ring, chats: CHATS, configOverrides: { paths: { downloadsDir } } });

  server.mock.respondTo(EVENT_INFO_EVENT, (frame) => {
    const requested = (frame.payload as Record<string, unknown>)['sync_ids'] as string[];
    return {
      status: 'ok',
      response: {
        [EVENT_INFO_EVENT]: historyEvents.filter((event) =>
          requested.includes(event['sync_id'] as string),
        ),
      },
    };
  });
  server.mock.respondTo(EVENTS_HISTORY_EVENT, () => ({ status: 'ok', response: { history: [] } }));

  /*
   * Загрузчик ходит глобальным fetch: подменяется он, а не зависимость сервера, потому что
   * подмена внутри сервера означала бы проверку не того кода, который поедет в бой.
   */
  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0]) => {
    fileServiceCalls.push(String(input));
    return fileServiceStatus === 200
      ? new Response(FILE_BYTES, { status: 200 })
      : new Response('файловая служба отказала', { status: fileServiceStatus });
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await server.close();
  await rm(downloadsDir, { recursive: true, force: true });
});

describe('download_attachment', () => {
  it('кладёт вложение на диск и объявляет форму неподтверждённой', async () => {
    const payload = await server.callTool<DownloadAttachmentResult>('download_attachment', {
      chat: 'Избранное',
      message_id: syncId(2),
    });
    if (payload.status !== 'ok') {
      throw new Error('ожидалась успешная выдача');
    }

    expect(payload.file_name).toBe(`${FILE_ID}-снимок.png`);
    expect(payload.size).toBe(FILE_BYTES.byteLength);
    expect(payload.mime_type).toBe('image/png');
    /* Файл зашифрован потоковым шифром, и шифр не снят: об этом сказано прямо */
    expect(payload.encrypted).toBe(true);
    expect(payload.form_status).toBe('unconfirmed');
    expect(payload.form_note).toContain('живьём');
    expect(new Uint8Array(await readFile(payload.path))).toEqual(FILE_BYTES);
    expect(await readdir(join(downloadsDir, POLYGON_CHAT_ID))).toHaveLength(1);
    expect(fileServiceCalls[0]).toContain(FILE_ID);
  });

  it('адресное вложение выбирается по file_id, а незнакомый file_id это отказ', async () => {
    const found = await server.callTool<DownloadAttachmentResult>('download_attachment', {
      chat: 'Избранное',
      message_id: syncId(2),
      file_id: FILE_ID,
    });
    expect(found.status).toBe('ok');

    const missing = await server.callTool<DownloadAttachmentResult>('download_attachment', {
      chat: 'Избранное',
      message_id: syncId(2),
      file_id: 'нет такого файла',
    });

    expect(missing.status).toBe('file_not_found');
    expect(missing.status === 'file_not_found' && missing.reason).toContain('нет такого файла');
  });

  it('сообщение без вложений это file_not_found, а не пустой успех', async () => {
    const payload = await server.callTool<DownloadAttachmentResult>('download_attachment', {
      chat: 'Избранное',
      message_id: syncId(1),
    });

    expect(payload.status).toBe('file_not_found');
    expect(fileServiceCalls).toHaveLength(0);
  });

  it('несуществующее сообщение это message_not_found с инструкцией', async () => {
    const payload = await server.callTool<DownloadAttachmentResult>('download_attachment', {
      chat: 'Избранное',
      message_id: syncId(99),
    });

    expect(payload.status).toBe('message_not_found');
    expect(fileServiceCalls).toHaveLength(0);
  });

  it('отказ файловой службы доезжает до MCP с тегом слоя и не оставляет файла', async () => {
    fileServiceStatus = 500;

    const text = await server.callToolExpectingError('download_attachment', {
      chat: 'Избранное',
      message_id: syncId(2),
    });

    expect(text).toContain('download_attachment:');
    expect(text).toContain('[rest] 500');
    await expect(readdir(join(downloadsDir, POLYGON_CHAT_ID))).rejects.toThrow();
  });
});
