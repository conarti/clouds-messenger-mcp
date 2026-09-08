/**
 * Генератор синтетических зашифрованных событий для тестов.
 *
 * Ключи и события здесь ВСЕГДА синтетические: живой материал в исходниках остался бы
 * в истории и в любом форке. Шаги шифрования повторены вручную, чтобы фикстура не зависела
 * от `src/crypto` и не превращала проверку в тавтологию.
 */
import sodium from 'libsodium-wrappers-sumo';
import type { PrivateKeyEntry } from '../../src/auth/AuthProvider.js';

/** Тот же алгоритм, что и на проводе; повторён здесь намеренно, фикстура ничего не импортирует из src */
export const FIXTURE_ALGO_AEAD = 'xsalsa20:xchacha20_aead_ietf';

/** Старый алгоритм тела: события до перехода на AEAD, читаются secretbox без связанных данных */
export const FIXTURE_ALGO_SECRETBOX = 'xsalsa20:chacha20';

const NONCE_BYTES = 24;
const CONTENT_KEY_BYTES = 32;

function encode(bytes: Uint8Array): string {
  return sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
}

function withNonce(nonce: Uint8Array, cipher: Uint8Array): Uint8Array {
  const result = new Uint8Array(nonce.length + cipher.length);
  result.set(nonce);
  result.set(cipher, nonce.length);
  return result;
}

/** Пара обмена x25519 вместе с записью в форме материала профиля */
export interface KeyPairFixture {
  keyId: string;
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  /** Ровно та форма, в которой приватный ключ приезжает из профиля: base64 тела плюс id публичной половины */
  privateKeyEntry: PrivateKeyEntry;
}

/** Пара подписи ed25519 */
export interface SignKeyFixture {
  keyId: string;
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export interface KeyRing {
  sender: KeyPairFixture;
  /** Двое получателей: столько же их у живого чата, на котором снята форма отправки */
  recipients: [KeyPairFixture, KeyPairFixture];
  sign: SignKeyFixture;
}

function makeKeyPair(keyId: string): KeyPairFixture {
  const pair = sodium.crypto_box_keypair();
  return {
    keyId,
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
    privateKeyEntry: { body: encode(pair.privateKey), publicKeyId: keyId },
  };
}

export async function makeKeyRing(): Promise<KeyRing> {
  await sodium.ready;
  const signPair = sodium.crypto_sign_keypair();
  return {
    sender: makeKeyPair('sender-key-id'),
    recipients: [makeKeyPair('recipient-key-id-a'), makeKeyPair('recipient-key-id-b')],
    sign: {
      keyId: 'sign-key-id',
      publicKey: signPair.publicKey,
      privateKey: signPair.privateKey,
    },
  };
}

/** Событие в форме записи `events_history`: ровно те поля, которые нужны расшифровке */
export interface HistoryEventFixture {
  group_chat_id: string;
  sync_id: string;
  sender_key_id: string;
  key: {
    key_id: string;
    key: string;
    algo: string;
  };
  payload: string;
}

export interface EncryptInnerEventInput {
  innerEvent: Record<string, unknown>;
  groupChatId: string;
  syncId: string;
  senderKeyId: string;
  /**
   * Приватная половина отправителя. Одного `senderKeyId` не хватает: обёртка считается
   * приватным ключом, а публичная половина выводится из него для проверки получателем.
   */
  senderPrivateKey: Uint8Array;
  recipient: KeyPairFixture;
  algo?: string;
}

export interface EncryptedEventFixture {
  event: HistoryEventFixture;
  /** Приватная половина получателя в форме материала профиля */
  recipientPrivateKeyEntry: PrivateKeyEntry;
  /** Публичная половина отправителя: ею открывается обёртка контент-ключа */
  senderPublicKey: Uint8Array;
}

export async function encryptInnerEvent(
  input: EncryptInnerEventInput,
): Promise<EncryptedEventFixture> {
  await sodium.ready;
  const algo = input.algo ?? FIXTURE_ALGO_AEAD;
  const contentKey = sodium.randombytes_buf(CONTENT_KEY_BYTES);

  const bodyNonce = sodium.randombytes_buf(NONCE_BYTES);
  const innerBytes = new TextEncoder().encode(JSON.stringify(input.innerEvent));
  const cipher =
    algo === FIXTURE_ALGO_AEAD
      ? sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
          innerBytes,
          `${input.groupChatId}:${input.syncId}`,
          null,
          bodyNonce,
          contentKey,
        )
      : sodium.crypto_secretbox_easy(innerBytes, bodyNonce, contentKey);

  const wrapNonce = sodium.randombytes_buf(NONCE_BYTES);
  const wrapped = sodium.crypto_box_easy(
    contentKey,
    wrapNonce,
    input.recipient.publicKey,
    input.senderPrivateKey,
  );

  return {
    event: {
      group_chat_id: input.groupChatId,
      sync_id: input.syncId,
      sender_key_id: input.senderKeyId,
      key: {
        key_id: input.recipient.keyId,
        key: encode(withNonce(wrapNonce, wrapped)),
        algo,
      },
      payload: encode(withNonce(bodyNonce, cipher)),
    },
    recipientPrivateKeyEntry: input.recipient.privateKeyEntry,
    senderPublicKey: sodium.crypto_scalarmult_base(input.senderPrivateKey),
  };
}
