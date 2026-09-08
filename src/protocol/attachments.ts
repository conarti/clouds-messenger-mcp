/**
 * Вложения внутреннего события.
 *
 * ФОРМА НАБЛЮДЕНА ЖИВЬЁМ (findings.md, P2): внутреннее событие типа `image` (и родственный
 * `file`) несёт `payload` с полями `file`, `file_name`, `file_size`, `file_hash`,
 * `file_mime_type`, `chunk_size`, `file_encryption_algo`, `file_preview`,
 * `file_preview_width`, `file_preview_height`, `blur_preview_file`, `file_id`.
 *
 * ПРИЗНАК ВЛОЖЕНИЯ ЭТО `file_id`, А НЕ СПИСОК ТИПОВ. Живьём наблюдены `image` и `file`,
 * но закрытым набор файловых типов никто не объявлял, и проверка по типу теряла бы
 * вложение молча на первом же новом виде события.
 *
 * ПРЕВЬЮ НАРУЖУ НЕ УХОДИТ. `file_preview` и `blur_preview_file` это байты картинки: в
 * выдаче инструмента им делать нечего, поэтому остаётся только булев признак наличия.
 */
import { asObject, numberOr, stringOr } from '../util/json.js';

export interface Attachment {
  file_id: string;
  file_name?: string;
  file_size?: number;
  file_mime_type?: string;
  file_hash?: string;
  /** Размер куска выкачки, наблюдено 2 МиБ */
  chunk_size?: number;
  /** Алгоритм шифрования файла, наблюдено значение `stream` */
  file_encryption_algo?: string;
  /** Есть ли у файла превью. Само превью наружу не отдаётся: это байты картинки */
  has_preview: boolean;
}

/**
 * Вложения внутреннего события. Пустой массив означает «вложений нет»: событие без
 * `payload.file_id` это обычное текстовое сообщение, а не сбой разбора.
 */
export function extractAttachments(inner: Record<string, unknown> | undefined): Attachment[] {
  const payload = asObject(inner?.['payload']);
  const fileId = stringOr(payload?.['file_id']);
  if (payload === undefined || fileId === undefined) {
    return [];
  }
  const fileName = stringOr(payload['file_name']);
  const fileSize = numberOr(payload['file_size']);
  const fileMimeType = stringOr(payload['file_mime_type']);
  const fileHash = stringOr(payload['file_hash']);
  const chunkSize = numberOr(payload['chunk_size']);
  const fileEncryptionAlgo = stringOr(payload['file_encryption_algo']);
  return [
    {
      file_id: fileId,
      ...(fileName !== undefined ? { file_name: fileName } : {}),
      ...(fileSize !== undefined ? { file_size: fileSize } : {}),
      ...(fileMimeType !== undefined ? { file_mime_type: fileMimeType } : {}),
      ...(fileHash !== undefined ? { file_hash: fileHash } : {}),
      ...(chunkSize !== undefined ? { chunk_size: chunkSize } : {}),
      ...(fileEncryptionAlgo !== undefined ? { file_encryption_algo: fileEncryptionAlgo } : {}),
      has_preview: stringOr(payload['file_preview']) !== undefined,
    },
  ];
}

/**
 * Выбор вложения из сообщения: по `file_id`, а без него первое.
 *
 * Первое, а не «самое подходящее»: живьём в одном событии наблюдалось ровно одно вложение,
 * и выдумывать правило выбора там, где выбора нет, значит закрепить догадку кодом.
 */
export function selectAttachment(
  attachments: readonly Attachment[],
  fileId?: string,
): Attachment | undefined {
  if (fileId === undefined) {
    return attachments[0];
  }
  return attachments.find((attachment) => attachment.file_id === fileId);
}
