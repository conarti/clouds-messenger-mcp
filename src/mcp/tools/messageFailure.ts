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

export function messageNotReadable(reason: string): MessageNotReadable {
  return { status: 'message_not_readable', reason, next_step: NOT_READABLE_NEXT_STEP };
}
