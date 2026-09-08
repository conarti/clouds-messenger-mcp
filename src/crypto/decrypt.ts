/**
 * Расшифровка входящего события.
 *
 * Последовательность снята с веб-клиента и подтверждена живой пробой: обёртка контент-ключа
 * открывается crypto_box, тело открывается AEAD со связанными данными, внутреннее событие
 * приезжает как JSON. Порядок шагов и состав связанных данных менять нельзя.
 */
import sodium from 'libsodium-wrappers-sumo';
import { asObject } from '../util/json.js';
import type { DecryptKeys, EncryptedEventRef } from './types.js';
import {
  CONTENT_ALGO_AEAD,
  NONCE_BYTES,
  buildAdditionalData,
  decodeBase64,
  ensureSodiumReady,
} from './sodium.js';

/** Шаг, на котором расшифровка встала: каждый указывает на свою причину */
export type DecryptStage = 'wrap' | 'body' | 'json';

/**
 * Диагноз по шагу. Симптом у всех трёх отказов один (событие не прочиталось), а причины
 * разные, и без разделения отладка сводится к перебору.
 */
const STAGE_DIAGNOSIS: Record<DecryptStage, string> = {
  wrap: 'Обёртка контент-ключа не открылась: событие зашифровано на другую пару ключей либо публичная половина отправителя взята не та.',
  body: 'Тело события не открылось: не сошёлся тег, обычно из-за расхождения group_chat_id или sync_id в связанных данных.',
  json: 'Открытое тело события не разбирается как JSON-объект: расшифровка удалась, но внутри не событие.',
};

/** Длина причины в тексте отказа: хватает на диагноз и не тащит в лог простыню */
const MAX_CAUSE_LENGTH = 160;

/**
 * Отказ расшифровки.
 *
 * Диагноз перечисляет идентификаторы (ключа, чата, события), но НИКОГДА не тела ключей
 * и не открытый текст: ошибка уезжает в лог и в баг-репорт, и там им не место.
 */
export class DecryptError extends Error {
  constructor(
    readonly stage: DecryptStage,
    readonly keyId: string,
    readonly groupChatId: string,
    readonly syncId: string,
    readonly reason: string,
  ) {
    super(
      `${STAGE_DIAGNOSIS[stage]} Ключ получателя ${keyId}, чат ${groupChatId}, sync_id ${syncId}. ` +
        `Причина: ${reason}`,
    );
    this.name = 'DecryptError';
  }
}

function describeCause(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_CAUSE_LENGTH);
}

/**
 * Открывает событие и отдаёт внутреннее событие разобранным объектом.
 *
 * Ветка secretbox оставлена для старого алгоритма: события, снятые до перехода на AEAD,
 * лежат в истории и читаются тем же путём, только без связанных данных.
 */
export async function decryptEvent(
  event: EncryptedEventRef,
  keys: DecryptKeys,
): Promise<Record<string, unknown>> {
  await ensureSodiumReady();

  const fail = (stage: DecryptStage, error: unknown): DecryptError =>
    new DecryptError(
      stage,
      event.key.key_id,
      event.group_chat_id,
      event.sync_id,
      describeCause(error),
    );

  let contentKey: Uint8Array;
  try {
    const wrapped = decodeBase64(event.key.key);
    contentKey = sodium.crypto_box_open_easy(
      wrapped.slice(NONCE_BYTES),
      wrapped.slice(0, NONCE_BYTES),
      keys.senderPublicKey,
      keys.recipientPrivateKey,
    );
  } catch (error) {
    throw fail('wrap', error);
  }

  let plain: Uint8Array;
  try {
    const body = decodeBase64(event.payload);
    const nonce = body.slice(0, NONCE_BYTES);
    const cipher = body.slice(NONCE_BYTES);
    plain =
      event.key.algo === CONTENT_ALGO_AEAD
        ? sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
            null,
            cipher,
            buildAdditionalData(event.group_chat_id, event.sync_id),
            nonce,
            contentKey,
          )
        : sodium.crypto_secretbox_open_easy(cipher, nonce, contentKey);
  } catch (error) {
    throw fail('body', error);
  }

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(plain);
    const inner = asObject(JSON.parse(text));
    if (!inner) {
      throw new Error('верхний уровень не объект');
    }
    return inner;
  } catch (error) {
    throw fail('json', error);
  }
}
