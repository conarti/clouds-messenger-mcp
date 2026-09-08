/**
 * Разбор вложений внутреннего события.
 *
 * Фикстура повторяет живую форму события с картинкой (findings.md, P2), включая поля
 * превью. Проверяется в том числе, что превью НАРУЖУ НЕ УХОДИТ: это байты картинки, и
 * место им в файле на диске, а не в контексте модели.
 */
import { describe, expect, it } from 'vitest';
import { extractAttachments, selectAttachment } from '../../src/protocol/attachments.js';
import { MY_HUID, POLYGON_CHAT_ID, makeInnerImage, makeInnerText } from '../helpers/readFixtures.js';

const FILE_ID = 'c0ffee00-0000-4000-8000-000000000001';
const OTHER_FILE_ID = 'c0ffee00-0000-4000-8000-000000000002';

function imageInner(fileId = FILE_ID): Record<string, unknown> {
  return makeInnerImage({
    msgId: '00000000-0000-4000-8000-000000000003',
    from: MY_HUID,
    timestamp: '2026-09-08T07:03:00.000Z',
    groupChatId: POLYGON_CHAT_ID,
    fileId,
    fileName: 'снимок.png',
  });
}

describe('extractAttachments', () => {
  it('снимает с живой формы все поля вложения', () => {
    expect(extractAttachments(imageInner())).toEqual([
      {
        file_id: FILE_ID,
        file_name: 'снимок.png',
        file_size: 155380,
        file_mime_type: 'image/png',
        file_hash: 'синтетический хеш',
        chunk_size: 2097152,
        file_encryption_algo: 'stream',
        has_preview: true,
      },
    ]);
  });

  it('превью остаётся признаком и байтами наружу не уходит', () => {
    const [attachment] = extractAttachments(imageInner());

    expect(attachment?.has_preview).toBe(true);
    expect(JSON.stringify(attachment)).not.toContain('превью');
    expect(Object.keys(attachment ?? {})).not.toContain('file_preview');
    expect(Object.keys(attachment ?? {})).not.toContain('blur_preview_file');
  });

  it('текстовое событие и событие без file_id вложений не дают', () => {
    const text = makeInnerText({
      msgId: '00000000-0000-4000-8000-000000000001',
      from: MY_HUID,
      timestamp: '2026-09-08T07:01:00.000Z',
      groupChatId: POLYGON_CHAT_ID,
      body: 'просто текст',
    });

    expect(extractAttachments(text)).toEqual([]);
    expect(extractAttachments(undefined)).toEqual([]);
    expect(extractAttachments({ type: 'image', payload: { file_name: 'без адреса' } })).toEqual([]);
  });

  it('признак вложения это file_id, а не совпадение типа со списком', () => {
    const unknownType = { type: 'тип, которого мы не видели', payload: { file_id: FILE_ID } };

    expect(extractAttachments(unknownType)).toEqual([{ file_id: FILE_ID, has_preview: false }]);
  });
});

describe('selectAttachment', () => {
  const attachments = [
    { file_id: FILE_ID, has_preview: false },
    { file_id: OTHER_FILE_ID, has_preview: false },
  ];

  it('без file_id берёт первое вложение', () => {
    expect(selectAttachment(attachments)?.file_id).toBe(FILE_ID);
  });

  it('с file_id берёт названное вложение', () => {
    expect(selectAttachment(attachments, OTHER_FILE_ID)?.file_id).toBe(OTHER_FILE_ID);
  });

  it('незнакомый file_id это отсутствие вложения, а не первое попавшееся', () => {
    expect(selectAttachment(attachments, 'нет такого')).toBeUndefined();
    expect(selectAttachment([])).toBeUndefined();
  });
});
