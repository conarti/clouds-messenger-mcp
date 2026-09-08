/**
 * Исходящее сообщение: сборка и отправка кадра `message_new` в топик чата.
 *
 * ФОРМА ВОСПРОИЗВЕДЕНА ЖИВОЙ ПРОБОЙ (Фаза 0, P1): кадр собран своим кодом, принят сервером
 * с `inserted_at`, прочитан обратно и расшифрован, тело совпало. Метки неподтверждённости
 * у этой формы нет.
 *
 * ПОЛУЧАТЕЛИ ТОЛЬКО ИЗ ЧАТА. Обёртка контент-ключа идёт на ключи из `chat.keys`, чьи
 * публичные тела приезжают из KDC. Вывод получателей из локального профиля это не
 * оптимизация, а отказ отправки: живая проба на обёртке по своему профилю дала
 * `invalid_keys` (локальный rts в получатели полигона не входил вовсе).
 *
 * ОБЁРТКА ИДЁТ ОДНИМ КЛЮЧОМ ОТПРАВИТЕЛЯ. Все записи `keys[]` считаются одним приватным
 * ключом обмена `cts`, а не ключом того же вида, что у получателя: это тоже снято живой
 * пробой, и попытка «подобрать вид ключа под получателя» ломает открытие обёртки.
 *
 * ПОВТОРА НЕТ И БЫТЬ НЕ МОЖЕТ. Отправка необратима: сервер мог принять кадр и не успеть
 * ответить, поэтому слепой повтор задвоил бы сообщение у собеседника. Именно поэтому
 * `sendMessageNew` передаёт транспорту `retry:false` ЯВНО, а не полагается на умолчание,
 * которое рассчитано на идемпотентное чтение.
 */
import type { AuthProvider } from '../auth/AuthProvider.js';
import { decodeBase64 } from '../crypto/sodium.js';
import type { CryptoService, MessageNewPayload } from '../crypto/types.js';
import { createRequestId } from '../transport/requestId.js';
import type { PhoenixClient } from '../transport/ws/types.js';
import { asObject, stringOr } from '../util/json.js';
import type { Logger } from '../util/logger.js';
import { toIso } from '../util/timestamps.js';
import type { ChatRecord } from './chatShape.js';
import { chatTopic } from './history.js';

/** Событие отправки на проводе */
export const MESSAGE_NEW_EVENT = 'message_new';

/**
 * В профиле нет ключа обмена `cts`.
 *
 * Отдельный класс, потому что чинится это не повтором и не сменой чата, а переоткрытием
 * профиля: без приватной половины отправителя обёртку контент-ключа считать нечем, и
 * молчаливая подстановка любого другого ключа дала бы `invalid_keys` на сервере, то есть
 * увела бы диагноз к получателям, у которых всё в порядке.
 */
export class SenderKeyMissingError extends Error {
  constructor() {
    super(
      'в ключевом материале профиля нет приватного ключа обмена cts, а обёртка контент-ключа ' +
        'считается именно им: переоткройте сессию мессенджера, чтобы профиль отдал ключи заново',
    );
    this.name = 'SenderKeyMissingError';
  }
}

/** Зависимости мутаций: сокет, ключи и лог. Ни REST, ни конфига здесь не нужно */
export interface MutationDeps {
  ws: PhoenixClient;
  auth: AuthProvider;
  crypto: CryptoService;
  logger: Logger;
}

export interface TextInnerEventInput {
  /** Мой huid: он едет в поле отправителя внутреннего события */
  huid: string;
  groupChatId: string;
  text: string;
  /** Идентификатор сообщения внутри события: отдельный от идентификатора отправки */
  msgId: string;
  /** ISO-8601 */
  timestamp: string;
}

/**
 * Внутреннее событие текста ровно в той форме, в какой оно наблюдено живьём.
 *
 * Поля координат и флаги пересылки присутствуют ВСЕГДА и нулевыми: живой клиент шлёт
 * именно так, а состав полей внутреннего события входит в подписанный шифротекст, поэтому
 * «лишнее не отправлять» здесь означает отправить не то, что принято сервером в пробе.
 */
export function buildTextInnerEvent(input: TextInnerEventInput): Record<string, unknown> {
  return {
    type: 'text',
    msg_id: input.msgId,
    from: input.huid,
    timestamp: input.timestamp,
    group_chat_id: input.groupChatId,
    lat: 0,
    lng: 0,
    link_meta_disabled: false,
    stealth_forwarding: false,
    body: input.text,
  };
}

export interface BuildMessageNewInput {
  /** Запись чата целиком: из неё берутся и адрес, и список получателей */
  chat: ChatRecord;
  text: string;
  /** Идентификатор отправки, придуманный вызывающим на шаге черновика */
  syncId: string;
  deps: MutationDeps;
}

/** Готовый кадр: адрес топика, имя события и зашифрованная нагрузка */
export interface MessageNewRequest {
  topic: string;
  event: string;
  payload: MessageNewPayload;
}

/** Ответ сервера на принятую отправку. Метки нет, если сервер её не прислал */
export interface MessageNewAck {
  inserted_at?: string;
}

/**
 * Собирает кадр отправки. Ввода-вывода два: ключевой материал профиля и публичные тела
 * получателей из KDC. Самой отправки здесь нет намеренно: сборка обязана быть проверяемой
 * отдельно от необратимого шага.
 */
export async function buildMessageNewRequest(
  input: BuildMessageNewInput,
): Promise<MessageNewRequest> {
  const { chat, deps } = input;
  const [whoami, material] = await Promise.all([deps.auth.getWhoami(), deps.auth.getKeyMaterial()]);

  const senderKey = material.privateKeys.cts;
  if (senderKey === undefined) {
    throw new SenderKeyMissingError();
  }

  /*
   * Список получателей приезжает вместе с чатом. Никакого домешивания своего публичного
   * идентификатора и никакого хранилища ключей: подмена состава получателей это отказ
   * сервера, а не потеря одной обёртки.
   */
  const recipients = await deps.crypto.keys.resolveRecipientPublicKeys(chat.key_ids);

  const payload = await deps.crypto.encryptMessage({
    innerEvent: buildTextInnerEvent({
      huid: whoami.huid,
      groupChatId: chat.chat_id,
      text: input.text,
      /* Идентификатор сообщения свой: он не равен идентификатору отправки, это разные поля */
      msgId: createRequestId(),
      timestamp: toIso(new Date()),
    }),
    groupChatId: chat.chat_id,
    syncId: input.syncId,
    recipients,
    senderPrivateKey: decodeBase64(senderKey.body),
    signPrivateKey: decodeBase64(material.signKeys.privateBody),
    signKeyId: material.signKeys.publicId,
  });

  deps.logger.debug('кадр отправки собран', {
    chatId: chat.chat_id,
    syncId: input.syncId,
    recipientCount: recipients.length,
  });

  return { topic: chatTopic(chat.chat_id), event: MESSAGE_NEW_EVENT, payload };
}

/**
 * Отправляет собранный кадр. `retry:false` передаётся ЯВНО: умолчание транспорта разрешает
 * повтор, потому что рассчитано на чтение, а здесь повтор означал бы второе сообщение
 * у собеседника.
 */
export async function sendMessageNew(
  deps: MutationDeps,
  request: MessageNewRequest,
): Promise<MessageNewAck> {
  const response = await deps.ws.request<unknown>(request.topic, request.event, request.payload, {
    retry: false,
  });
  const insertedAt = stringOr(asObject(response)?.['inserted_at']);
  deps.logger.info('сообщение принято сервером', {
    chatId: request.payload.group_chat_id,
    syncId: request.payload.sync_id,
  });
  return insertedAt === undefined ? {} : { inserted_at: insertedAt };
}
