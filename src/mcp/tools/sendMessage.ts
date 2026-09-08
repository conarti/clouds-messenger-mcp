/**
 * `send_message`: единственная необратимая операция набора, поэтому она двухшаговая.
 *
 * ШАГ 1 (по умолчанию): резолв чата, превью текста, токен подтверждения. На провод не
 * уходит НИЧЕГО мутирующего.
 * ШАГ 2 (`confirm:true` вместе с токеном): чат резолвится ЗАНОВО, отпечаток считается
 * ЗАНОВО, оба сверяются с токеном, и только после этого собирается и уходит кадр.
 *
 * ЗАЧЕМ ПЕРЕПРОВЕРКА, А НЕ «ОТПРАВИТЬ ТО, ЧТО В ТОКЕНЕ». Между шагами может смениться всё:
 * тот же запрос `chat` завтра резолвится в другой чат (чат переименовали, появился
 * однофамилец), а вызывающий мог подставить к старому токену другой текст. Расхождение это
 * отказ, а не выбор «наиболее вероятного»: цена ошибки здесь это сообщение не тому
 * человеку.
 *
 * НЕОДНОЗНАЧНОСТЬ НЕ РАЗРЕШАЕТСЯ ГАДАНИЕМ. Несколько кандидатов означает выдачу кандидатов
 * наружу, и ни один кадр при этом не уходит: выбор делает вызывающий.
 *
 * ОТКАЗ ПОДТВЕРЖДЕНИЯ ЭТО СТАТУС, А НЕ ОШИБКА ВЫЗОВА. Он чинится следующим вызовом ровно
 * так же, как неоднозначность адресации: повторить черновик и предъявить свежий токен.
 * Ошибкой MCP наружу уходит только отказ сервера, потому что чинить его вызывающему нечем.
 */
import { resolveChat } from '../../chat/resolveChat.js';
import { resolveFailure, type ChatResolveFailure } from '../../chat/resolveFailure.js';
import { buildMessageNewRequest, sendMessageNew } from '../../protocol/mutations.js';
import { createRequestId } from '../../transport/requestId.js';
import {
  ConfirmRejectedError,
  confirmMemory,
  encodeToken,
  fingerprint,
  verifyConfirm,
  type ConfirmRejectReason,
  type DraftToken,
} from '../confirm.js';
import type { ToolDeps } from './deps.js';

/** `| undefined` в необязательных полях: под exactOptionalPropertyTypes zod отдаёт такой тип */
export interface SendMessageInput {
  chat: string;
  text: string;
  confirm?: boolean | undefined;
  confirm_token?: string | undefined;
}

/** Потолок длины текста; тем же числом ограничена схема параметра */
export const TEXT_MAX_LENGTH = 10_000;

/** Потолок превью: столько символов текста показывается на подтверждении */
export const TEXT_PREVIEW_LIMIT = 200;

export interface SendMessageDraft {
  status: 'draft';
  chat_id: string;
  /** Имя чата, если оно у чата есть: подтверждать отправку по одному UUID человек не может */
  chat_name?: string;
  /** Начало текста, ЧТОБЫ ЧИТАТЬ; предметом отпечатка является текст целиком */
  text_preview: string;
  confirm_token: string;
  next_step: string;
}

export interface SendMessageSent {
  status: 'sent';
  chat_id: string;
  /** Идентификатор отправки: он же адрес сообщения в истории */
  message_id: string;
  /** Метка сервера; отсутствует, если сервер её не прислал */
  inserted_at?: string;
}

export interface SendMessageConfirmRejected {
  status: 'confirm_rejected';
  reason: ConfirmRejectReason;
  next_step: string;
}

export type SendMessageResult =
  | SendMessageDraft
  | SendMessageSent
  | SendMessageConfirmRejected
  | ChatResolveFailure;

/**
 * Нагрузка отпечатка выписана ДОСЛОВНО, а не сериализацией объекта: порядок ключей у
 * `JSON.stringify` зависит от того, как объект собран, и расхождение здесь означало бы
 * ложный отказ на каждой второй отправке.
 *
 * Разбор строки однозначен, потому что адрес чата это UUID: перевода строки в нём быть не
 * может, поэтому первый перевод строки всегда отделяет адрес от текста, и текст с любым
 * числом переводов строк и двоеточий внутри не может дать ту же строку в паре с другим
 * адресом.
 */
export function buildSendPayload(chatId: string, text: string): string {
  return `${chatId}\n${text}`;
}

/** Отпечаток отправки: домен-сепарация операцией поверх дословной нагрузки */
export function sendFingerprint(chatId: string, text: string): string {
  return fingerprint('send', buildSendPayload(chatId, text));
}

/** Превью укладывается в потолок вместе с меткой обрезки: иначе непонятно, что текст длиннее */
function previewOf(text: string): string {
  if (text.length <= TEXT_PREVIEW_LIMIT) {
    return text;
  }
  return `${text.slice(0, TEXT_PREVIEW_LIMIT - 3)}...`;
}

const DRAFT_NEXT_STEP =
  'Ничего не отправлено. Чтобы отправить, повторите вызов send_message с confirm:true, тем же ' +
  'confirm_token и НЕИЗМЕНЁННЫМИ chat и text: изменение любого из них отклонит отправку. Поле ' +
  'text_preview только для чтения, эхом возвращайте исходный text, а не превью.';

/**
 * Инструкция на каждую причину отказа. Без неё дискриминатор нем: вызывающий понимает, ЧТО
 * случилось, но не понимает, чем это чинить, и повторяет тот же вызов.
 */
const REJECTED_NEXT_STEP: Record<ConfirmRejectReason, string> = {
  missing_token:
    'подтверждение требует confirm_token: сделайте вызов без confirm, получите токен и ' +
    'предъявите его вместе с confirm:true',
  malformed_token:
    'confirm_token не разобран: возьмите значение из последнего ответа со status:"draft" ' +
    'целиком, без переносов и обрезки',
  op_mismatch:
    'этот токен выпущен другой операцией: получите токен вызовом send_message без confirm',
  chat_mismatch:
    'запрос chat теперь резолвится в другой чат, чем на шаге черновика: повторите вызов без ' +
    'confirm, сверьте chat_id в ответе и подтверждайте свежим токеном',
  fingerprint_mismatch:
    'текст отличается от подтверждённого: повторите вызов без confirm с нужным текстом и ' +
    'подтверждайте свежим токеном',
};

export async function sendMessage(
  deps: ToolDeps,
  input: SendMessageInput,
): Promise<SendMessageResult> {
  const resolved = await resolveChat(deps, input.chat);
  if (resolved.kind !== 'resolved') {
    return resolveFailure(resolved);
  }
  const chat = resolved.chat;

  if (input.confirm !== true) {
    /*
     * Идентификатор отправки придумывается здесь, на черновике, и запоминается в токене.
     * Сгенерированный на шаге подтверждения означал бы, что повтор подтверждения это новая
     * отправка с новым адресом.
     */
    const draft: DraftToken = {
      op: 'send',
      chat_id: chat.chat_id,
      fingerprint: sendFingerprint(chat.chat_id, input.text),
      sync_id: createRequestId(),
    };
    deps.logger.info('send_message: подготовлен черновик, на провод ничего не ушло', {
      chatId: chat.chat_id,
      syncId: draft.sync_id,
      textLength: input.text.length,
    });
    return {
      status: 'draft',
      chat_id: chat.chat_id,
      ...(chat.name !== undefined ? { chat_name: chat.name } : {}),
      text_preview: previewOf(input.text),
      confirm_token: encodeToken(draft),
      next_step: DRAFT_NEXT_STEP,
    };
  }

  /* Пустая строка вместо отсутствия: перепроверка отвергнет её той же причиной */
  const token = input.confirm_token ?? '';
  let draft: DraftToken;
  try {
    draft = verifyConfirm({
      op: 'send',
      token,
      chatId: chat.chat_id,
      fingerprint: sendFingerprint(chat.chat_id, input.text),
    });
  } catch (error) {
    if (!(error instanceof ConfirmRejectedError)) {
      throw error;
    }
    deps.logger.warn('send_message: подтверждение отвергнуто, ничего не отправлено', {
      chatId: chat.chat_id,
      reason: error.reason,
    });
    return {
      status: 'confirm_rejected',
      reason: error.reason,
      next_step: REJECTED_NEXT_STEP[error.reason],
    };
  }

  const remembered = confirmMemory.recall<SendMessageSent>(token);
  if (remembered !== undefined) {
    deps.logger.warn('send_message: повторное подтверждение тем же токеном, второй кадр не ушёл', {
      chatId: chat.chat_id,
      syncId: draft.sync_id,
    });
    return remembered;
  }

  const request = await buildMessageNewRequest({
    chat,
    text: input.text,
    syncId: draft.sync_id,
    deps,
  });
  const ack = await sendMessageNew(deps, request);

  const result: SendMessageSent = {
    status: 'sent',
    chat_id: chat.chat_id,
    message_id: draft.sync_id,
    ...(ack.inserted_at !== undefined ? { inserted_at: ack.inserted_at } : {}),
  };
  /*
   * Запоминается ТОЛЬКО удавшаяся отправка. Отказ сервера уходит исключением мимо этого
   * места намеренно: запомнить неудачу значило бы отдать её и на повторе, лишив вызывающего
   * единственного законного способа переотправить сообщение тем же токеном.
   */
  confirmMemory.remember(token, result);
  return result;
}
