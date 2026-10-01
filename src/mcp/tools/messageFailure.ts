/**
 * Единая форма отказа адресации СООБЩЕНИЯ: одна на все инструменты, которым нужно событие
 * по паре чат и `message_id`.
 *
 * Причина та же, по которой отдельно живёт отказ адресации чата: форма, объявленная в
 * каждом инструменте заново, расходится на первой же правке, и вызывающий начинает
 * различать инструменты по форме тела вместо одного поля.
 *
 * ДВА РАЗНЫХ ОТКАЗА, А НЕ ОДИН. «Сообщения нет» и «сообщение есть, но не читается» чинятся
 * разным: первое сверкой адреса, второе разбирательством с ключами сессии. Свести их к
 * одному статусу значит отправить агента чинить не то место.
 */
import { parseMessageLink } from '../../chat/messageLink.js';

export interface MessageNotFound {
  status: 'message_not_found';
  reason: string;
  next_step: string;
}

export interface MessageNotReadable {
  status: 'message_not_readable';
  reason: string;
  next_step: string;
}

const NOT_FOUND_NEXT_STEP =
  'сверьте message_id: возьмите его из выдачи get_history по этому чату. Сообщение могло быть ' +
  'удалено либо принадлежать другому чату';

const NOT_READABLE_NEXT_STEP =
  'сообщение доехало, но расшифровать его нечем: проверьте, что сессия принадлежит участнику ' +
  'этого чата, и повторите вызов после переавторизации';

export function messageNotFound(reason: string): MessageNotFound {
  return { status: 'message_not_found', reason, next_step: NOT_FOUND_NEXT_STEP };
}

/** Адресное чтение ищет по всем чатам: событие постороннего чата это промах, а не находка */
export function messageOutsideChat(messageId: string, chatId: string): MessageNotFound {
  return messageNotFound(`сообщение ${messageId} лежит не в чате ${chatId} и не в его треде`);
}

export function messageNotReadable(reason: string): MessageNotReadable {
  return { status: 'message_not_readable', reason, next_step: NOT_READABLE_NEXT_STEP };
}

/** Адрес сообщения не передан ни явно, ни ссылкой: к серверу при этом не ходим */
export interface MessageInputInvalid {
  status: 'invalid_input';
  reason: string;
  next_step: string;
}

const MESSAGE_ID_MISSING_NEXT_STEP =
  'передайте message_id из выдачи get_history либо ссылку xlnk на сообщение в chat как есть';

export function messageIdMissing(): MessageInputInvalid {
  return {
    status: 'invalid_input',
    reason: 'не передан message_id, и в chat нет ссылки на сообщение с параметром sync_id',
    next_step: MESSAGE_ID_MISSING_NEXT_STEP,
  };
}

/** Явный `message_id` старше ссылки: ссылка подставляет адрес, только когда его не передали */
export function messageIdOf(input: { chat: string; message_id?: string | undefined }): string | undefined {
  return input.message_id ?? parseMessageLink(input.chat)?.messageId;
}
