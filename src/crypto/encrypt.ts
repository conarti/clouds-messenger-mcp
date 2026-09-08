/**
 * Шифрование исходящего события в payload кадра message_new.
 *
 * Форма воспроизведена живой пробой (отправлено своим кодом, принято сервером, прочитано
 * обратно и расшифровано). Обёртка идёт на КАЖДОГО получателя чата и ОДНИМ ключом
 * отправителя: обёртка на ключи из локального профиля даёт отказ `invalid_keys`.
 */
import sodium from 'libsodium-wrappers-sumo';
import type { EncryptMessageInput, MessageNewPayload } from './types.js';
import { SIGN_ALGO, signPayload } from './sign.js';
import {
  CONTENT_ALGO_AEAD,
  CONTENT_KEY_BYTES,
  NONCE_BYTES,
  buildAdditionalData,
  encodeBase64,
  ensureSodiumReady,
  prefixWithNonce,
} from './sodium.js';

export async function encryptMessage(input: EncryptMessageInput): Promise<MessageNewPayload> {
  await ensureSodiumReady();

  /* Контент-ключ одноразовый: он живёт ровно одно сообщение и никуда не сохраняется */
  const contentKey = sodium.randombytes_buf(CONTENT_KEY_BYTES);

  const bodyNonce = sodium.randombytes_buf(NONCE_BYTES);
  const innerBytes = new TextEncoder().encode(JSON.stringify(input.innerEvent));
  const cipher = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    innerBytes,
    buildAdditionalData(input.groupChatId, input.syncId),
    null,
    bodyNonce,
    contentKey,
  );
  const payload = encodeBase64(prefixWithNonce(bodyNonce, cipher));

  const keys = input.recipients.map((recipient) => {
    /* Свой нонс на каждого получателя: повтор нонса при общем ключе отправителя ломает crypto_box */
    const wrapNonce = sodium.randombytes_buf(NONCE_BYTES);
    const wrapped = sodium.crypto_box_easy(
      contentKey,
      wrapNonce,
      recipient.body,
      input.senderPrivateKey,
    );
    return {
      key_id: recipient.keyId,
      key: encodeBase64(prefixWithNonce(wrapNonce, wrapped)),
      algo: CONTENT_ALGO_AEAD,
    };
  });

  return {
    keys,
    group_chat_id: input.groupChatId,
    sync_id: input.syncId,
    payload,
    signature: {
      sign: await signPayload(payload, input.signPrivateKey),
      sign_key_id: input.signKeyId,
      sign_algo: SIGN_ALGO,
    },
  };
}
