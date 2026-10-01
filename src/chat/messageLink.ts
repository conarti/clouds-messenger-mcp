/**
 * Ссылка на сообщение из клиента: `https://xlnk.clouds.org.ru/open/message?sync_id=...&chat_id=...`.
 *
 * РАЗБОР МЯГКИЙ ПО ФОРМЕ И СТРОГИЙ ПО ЗНАЧЕНИЯМ. Ссылку копируют со схемой и без неё, с
 * завершающим слешем и без, поэтому хост и схема не сверяются, а признаком ссылки служит путь
 * `/open/message`. Значения параметров при этом обязаны быть UUID: адрес, похожий на мусор,
 * считается отсутствующим, а не передаётся серверу.
 *
 * `chat_id` у сообщения из треда это адрес САМОГО ТРЕДА (так описано в issue #2), но ссылка
 * с адресом родительского чата тоже разбирается: какой из двух адресов пришёл, решает резолв.
 */
import { UUID_PATTERN } from '../protocol/messageShape.js';

/** Путь ссылки на сообщение: по нему строка отличается от имени чата */
const MESSAGE_LINK_PATH = /\/open\/message\/?$/i;

/** Есть ли у строки схема: без неё `URL` ссылку не разберёт */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

export interface MessageLink {
  /** `chat_id` ссылки: адрес чата либо треда */
  chatId?: string;
  /** `sync_id` ссылки: адрес сообщения */
  messageId?: string;
}

function uuidOrAbsent(value: string | null): string | undefined {
  return value !== null && UUID_PATTERN.test(value) ? value : undefined;
}

/** Ссылка на сообщение либо `undefined`, если строка ссылкой не является */
export function parseMessageLink(value: string): MessageLink | undefined {
  const trimmed = value.trim();
  if (!trimmed.includes('/open/message')) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(HAS_SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return undefined;
  }
  if (!MESSAGE_LINK_PATH.test(url.pathname)) {
    return undefined;
  }
  const chatId = uuidOrAbsent(url.searchParams.get('chat_id'));
  const messageId = uuidOrAbsent(url.searchParams.get('sync_id'));
  return {
    ...(chatId !== undefined ? { chatId } : {}),
    ...(messageId !== undefined ? { messageId } : {}),
  };
}
