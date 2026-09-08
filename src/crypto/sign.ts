/**
 * Подпись исходящего кадра.
 *
 * ВАЖНО: подписываются UTF-8 байты base64-СТРОКИ payload, а не сырой шифротекст. Это снято
 * верификацией живой подписи двумя способами: сходится только вариант со строкой, и подпись
 * над сырыми байтами сервер отвергнет.
 */
import sodium from 'libsodium-wrappers-sumo';
import { decodeBase64, encodeBase64, ensureSodiumReady } from './sodium.js';

/** Алгоритм подписи на проводе */
export const SIGN_ALGO = 'ed25519';

/** Байты, над которыми считается подпись: ровно строка payload в UTF-8 */
function signedBytes(payloadBase64: string): Uint8Array {
  return new TextEncoder().encode(payloadBase64);
}

export async function signPayload(
  payloadBase64: string,
  signPrivateKey: Uint8Array,
): Promise<string> {
  await ensureSodiumReady();
  return encodeBase64(sodium.crypto_sign_detached(signedBytes(payloadBase64), signPrivateKey));
}

/**
 * Проверка подписи. Отказ разбора подписи и отказ проверки это один ответ `false`:
 * для вызывающего разницы нет, а исключение из кодека увело бы диагноз в сторону.
 */
export async function verifyPayloadSignature(
  payloadBase64: string,
  signatureBase64: string,
  signPublicKey: Uint8Array,
): Promise<boolean> {
  await ensureSodiumReady();
  try {
    return sodium.crypto_sign_verify_detached(
      decodeBase64(signatureBase64),
      signedBytes(payloadBase64),
      signPublicKey,
    );
  } catch {
    return false;
  }
}
