/**
 * `download_attachment`: единственный инструмент, который кладёт что-то на диск.
 *
 * СКАЧИВАНИЕ ОТДЕЛЕНО ОТ ЧТЕНИЯ НАМЕРЕННО. Чтение отдаёт только ссылки на вложения, а
 * материализация чужого файла на диске остаётся отдельным явным действием: копия чужой
 * переписки не должна появляться просто потому, что агент листал историю.
 *
 * ФОРМА ЗАПРОСА И РАСШИФРОВКИ НЕ ПОДТВЕРЖДЕНА ЖИВЬЁМ (findings.md, P2: вложение в
 * сообщении наблюдалось, а скачивание нет), поэтому успешная выдача несёт
 * `form_status:'unconfirmed'`, а файл, приехавший зашифрованным, помечается `encrypted`.
 *
 * ОТКАЗ ОСТАЁТСЯ ОТКАЗОМ. Ошибка REST не превращается в пустой успех и не создаёт пустого
 * файла: файл нулевой длины на диске невозможно отличить от настоящего, а внятный отказ с
 * тегом слоя чинится.
 */
import { downloadAttachment as fetchAttachmentFile } from '../../attachments/downloader.js';
import { containerChatOf, resolveChat } from '../../chat/resolveChat.js';
import { resolveFailure, type ChatResolveFailure } from '../../chat/resolveFailure.js';
import { extractAttachments, selectAttachment } from '../../protocol/attachments.js';
import { decryptHistoryEvents } from '../../protocol/decryptHistory.js';
import { fetchEventBySyncId } from '../../protocol/eventInfo.js';
import {
  messageIdMissing,
  messageIdOf,
  messageNotFound,
  messageOutsideChat,
  messageNotReadable,
  type MessageInputInvalid,
  type MessageNotFound,
  type MessageNotReadable,
} from './messageFailure.js';
import type { ToolDeps } from './deps.js';

export interface DownloadAttachmentInput {
  /** Чат, тред либо ссылка xlnk на сообщение */
  chat: string;
  /** Без него адрес берётся из `sync_id` ссылки в `chat` */
  message_id?: string | undefined;
  /** Какое именно вложение: без него берётся первое вложение сообщения */
  file_id?: string | undefined;
}

export interface DownloadAttachmentOk {
  status: 'ok';
  /** Абсолютный путь: потребитель читает файл по нему */
  path: string;
  /** Имя на диске: оно очищено от разделителей пути и может отличаться от имени в чате */
  file_name: string;
  size: number;
  mime_type?: string;
  /** Файл сохранён как приехал, потоковый шифр с него не снят */
  encrypted?: true;
  form_status: 'unconfirmed';
  form_note: string;
}

export interface AttachmentNotFound {
  status: 'file_not_found';
  reason: string;
  next_step: string;
}

export type DownloadAttachmentResult =
  | DownloadAttachmentOk
  | AttachmentNotFound
  | MessageNotFound
  | MessageNotReadable
  | MessageInputInvalid
  | ChatResolveFailure;

const FORM_NOTE =
  'flow загрузки и расшифровки файла не отрабатывался живьём: адрес файловой службы и ' +
  'параметр key_id взяты из бандла веб-клиента, а потоковый шифр файла не снимается, потому ' +
  'что разметка потока живой пробой не проверялась. Файл с пометкой encrypted лежит на диске ' +
  'ровно таким, каким его отдал сервер';

const NOT_FOUND_NEXT_STEP =
  'сверьте file_id по полю attachments прочитанного сообщения: у сообщения без вложений ' +
  'скачивать нечего';

export async function downloadAttachment(
  deps: ToolDeps,
  input: DownloadAttachmentInput,
): Promise<DownloadAttachmentResult> {
  const messageId = messageIdOf(input);
  if (messageId === undefined) {
    return messageIdMissing();
  }
  const resolved = await resolveChat(deps, input.chat);
  if (resolved.kind !== 'resolved') {
    return resolveFailure(resolved);
  }

  const lookup = await fetchEventBySyncId(deps, { chatId: resolved.chat.chat_id, syncId: messageId });
  if (lookup.event === undefined) {
    return messageNotFound(`в чате ${resolved.chat.chat_id} нет события с sync_id ${messageId}`);
  }
  /*
   * Файловая служба отдаёт вложение треда только по адресу ТРЕДА (по адресу родителя 404),
   * поэтому сообщение треда, адресованное родительским чатом, качается адресом треда.
   */
  const chat = await containerChatOf(deps, resolved.chat, lookup.event);
  if (chat === undefined) {
    return messageOutsideChat(messageId, resolved.chat.chat_id);
  }

  const [decrypted] = await decryptHistoryEvents(deps, [lookup.event]);
  if (decrypted?.inner === undefined) {
    /* Ссылка на файл лежит в зашифрованном теле: без него неизвестно даже, есть ли вложение */
    return messageNotReadable(
      decrypted?.error ?? `тело события ${messageId} не разобрано, вложения в нём не видны`,
    );
  }

  const attachment = selectAttachment(extractAttachments(decrypted.inner), input.file_id);
  if (attachment === undefined) {
    return {
      status: 'file_not_found',
      reason:
        input.file_id === undefined
          ? `у сообщения ${messageId} нет вложений`
          : `у сообщения ${messageId} нет вложения с file_id ${input.file_id}`,
      next_step: NOT_FOUND_NEXT_STEP,
    };
  }

  const downloaded = await fetchAttachmentFile(
    { auth: deps.auth, config: deps.config, logger: deps.logger },
    { attachment, chatId: chat.chat_id },
  );

  return {
    status: 'ok',
    path: downloaded.path,
    file_name: downloaded.file_name,
    size: downloaded.size,
    ...(downloaded.mime_type !== undefined ? { mime_type: downloaded.mime_type } : {}),
    ...(downloaded.encrypted ? { encrypted: true as const } : {}),
    form_status: 'unconfirmed',
    form_note: FORM_NOTE,
  };
}
