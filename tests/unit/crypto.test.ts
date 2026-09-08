import { beforeAll, describe, expect, it, vi } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import { KeyNotFoundError, type KeyStore } from '../../src/auth/keyStore.js';
import { DecryptError, decryptEvent } from '../../src/crypto/decrypt.js';
import { encryptMessage } from '../../src/crypto/encrypt.js';
import { signPayload, verifyPayloadSignature } from '../../src/crypto/sign.js';
import type { EncryptedEventRef } from '../../src/crypto/types.js';
import {
  FIXTURE_ALGO_SECRETBOX,
  encryptInnerEvent,
  makeKeyRing,
  type KeyRing,
} from '../helpers/cryptoFixtures.js';

/**
 * Эталон рядом с проверяемым кодом.
 *
 * Шаги оракулов (расшифровка входящего и сборка message_new) повторены здесь ВРУЧНУЮ и
 * ничего не импортируют из `src/crypto`: проверка нашей реализации её же кодом доказала бы
 * только внутреннюю согласованность, а расходится с сервером как раз алгоритм.
 */
const ORACLE_ALGO_AEAD = 'xsalsa20:xchacha20_aead_ietf';
const ORACLE_NONCE_BYTES = 24;

const GROUP_CHAT_ID = '00000000-0000-4000-8000-00000000cha7';
const SYNC_ID = '00000000-0000-4000-8000-0000000005c1';

const INNER_EVENT = {
  type: 'text',
  msg_id: '00000000-0000-4000-8000-0000000000d1',
  from: '00000000-0000-4000-8000-000000000fff',
  timestamp: '2026-01-01T00:00:00.000Z',
  group_chat_id: GROUP_CHAT_ID,
  lat: 0,
  lng: 0,
  link_meta_disabled: false,
  stealth_forwarding: false,
  body: 'синтетический текст пробы',
};

function oracleDecode(value: string): Uint8Array {
  try {
    return sodium.from_base64(value, sodium.base64_variants.ORIGINAL);
  } catch {
    return sodium.from_base64(value, sodium.base64_variants.ORIGINAL_NO_PADDING);
  }
}

function oracleEncode(bytes: Uint8Array): string {
  return sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
}

function oracleJoin(nonce: Uint8Array, cipher: Uint8Array): Uint8Array {
  const result = new Uint8Array(nonce.length + cipher.length);
  result.set(nonce);
  result.set(cipher, nonce.length);
  return result;
}

/** Шаги p1-decrypt.mjs: обёртка crypto_box, затем тело AEAD со связанными данными */
function oracleDecrypt(input: {
  wrappedKeyBase64: string;
  payloadBase64: string;
  groupChatId: string;
  syncId: string;
  senderPublicKey: Uint8Array;
  recipientPrivateKey: Uint8Array;
}): Record<string, unknown> {
  const wrapped = oracleDecode(input.wrappedKeyBase64);
  const contentKey = sodium.crypto_box_open_easy(
    wrapped.slice(ORACLE_NONCE_BYTES),
    wrapped.slice(0, ORACLE_NONCE_BYTES),
    input.senderPublicKey,
    input.recipientPrivateKey,
  );
  const body = oracleDecode(input.payloadBase64);
  const plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    body.slice(ORACLE_NONCE_BYTES),
    `${input.groupChatId}:${input.syncId}`,
    body.slice(0, ORACLE_NONCE_BYTES),
    contentKey,
  );
  return JSON.parse(new TextDecoder().decode(plain)) as Record<string, unknown>;
}

/** Шаги p1-replay.mjs: контент-ключ, тело AEAD, обёртка на получателя */
function oracleEncrypt(input: {
  innerEvent: Record<string, unknown>;
  groupChatId: string;
  syncId: string;
  senderPrivateKey: Uint8Array;
  recipientPublicKey: Uint8Array;
  recipientKeyId: string;
  senderKeyId: string;
}): EncryptedEventRef {
  const contentKey = sodium.randombytes_buf(32);
  const bodyNonce = sodium.randombytes_buf(ORACLE_NONCE_BYTES);
  const cipher = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    new TextEncoder().encode(JSON.stringify(input.innerEvent)),
    `${input.groupChatId}:${input.syncId}`,
    null,
    bodyNonce,
    contentKey,
  );
  const wrapNonce = sodium.randombytes_buf(ORACLE_NONCE_BYTES);
  const wrapped = sodium.crypto_box_easy(
    contentKey,
    wrapNonce,
    input.recipientPublicKey,
    input.senderPrivateKey,
  );
  return {
    group_chat_id: input.groupChatId,
    sync_id: input.syncId,
    sender_key_id: input.senderKeyId,
    key: {
      key_id: input.recipientKeyId,
      key: oracleEncode(oracleJoin(wrapNonce, wrapped)),
      algo: ORACLE_ALGO_AEAD,
    },
    payload: oracleEncode(oracleJoin(bodyNonce, cipher)),
  };
}

let ring: KeyRing;

beforeAll(async () => {
  await sodium.ready;
  ring = await makeKeyRing();
});

async function encryptOnBothRecipients() {
  return encryptMessage({
    innerEvent: INNER_EVENT,
    groupChatId: GROUP_CHAT_ID,
    syncId: SYNC_ID,
    recipients: ring.recipients.map((recipient) => ({
      keyId: recipient.keyId,
      body: recipient.publicKey,
    })),
    senderPrivateKey: ring.sender.privateKey,
    signPrivateKey: ring.sign.privateKey,
    signKeyId: ring.sign.keyId,
  });
}

describe('round-trip против эталона', () => {
  it('наше шифрование читается эталоном у КАЖДОГО получателя', async () => {
    const message = await encryptOnBothRecipients();

    expect(message.keys).toHaveLength(2);
    for (const [index, recipient] of ring.recipients.entries()) {
      const entry = message.keys[index];
      expect(entry?.key_id).toBe(recipient.keyId);
      const inner = oracleDecrypt({
        wrappedKeyBase64: entry?.key ?? '',
        payloadBase64: message.payload,
        groupChatId: message.group_chat_id,
        syncId: message.sync_id,
        senderPublicKey: ring.sender.publicKey,
        recipientPrivateKey: recipient.privateKey,
      });
      expect(inner).toEqual(INNER_EVENT);
    }
  });

  it('эталонное шифрование читается нашим decryptEvent', async () => {
    const event = oracleEncrypt({
      innerEvent: INNER_EVENT,
      groupChatId: GROUP_CHAT_ID,
      syncId: SYNC_ID,
      senderPrivateKey: ring.sender.privateKey,
      senderKeyId: ring.sender.keyId,
      recipientPublicKey: ring.recipients[0].publicKey,
      recipientKeyId: ring.recipients[0].keyId,
    });

    const inner = await decryptEvent(event, {
      recipientPrivateKey: ring.recipients[0].privateKey,
      senderPublicKey: ring.sender.publicKey,
    });

    expect(inner).toEqual(INNER_EVENT);
  });

  it('подпись проверяется эталоном над UTF-8 байтами base64-строки payload', async () => {
    const message = await encryptOnBothRecipients();

    const signature = oracleDecode(message.signature.sign);
    const overBase64String = sodium.crypto_sign_verify_detached(
      signature,
      new TextEncoder().encode(message.payload),
      ring.sign.publicKey,
    );
    const overRawCiphertext = sodium.crypto_sign_verify_detached(
      signature,
      oracleDecode(message.payload),
      ring.sign.publicKey,
    );

    expect(overBase64String).toBe(true);
    /* Подпись над сырым шифротекстом это ровно та ошибка, из-за которой сервер отвергает кадр */
    expect(overRawCiphertext).toBe(false);
    expect(message.signature.sign_key_id).toBe(ring.sign.keyId);
    expect(message.signature.sign_algo).toBe('ed25519');
  });

  it('старая ветка secretbox открывается для чужого algo', async () => {
    const fixture = await encryptInnerEvent({
      innerEvent: INNER_EVENT,
      groupChatId: GROUP_CHAT_ID,
      syncId: SYNC_ID,
      senderKeyId: ring.sender.keyId,
      senderPrivateKey: ring.sender.privateKey,
      recipient: ring.recipients[0],
      algo: FIXTURE_ALGO_SECRETBOX,
    });

    const inner = await decryptEvent(fixture.event, {
      recipientPrivateKey: ring.recipients[0].privateKey,
      senderPublicKey: fixture.senderPublicKey,
    });

    expect(inner).toEqual(INNER_EVENT);
  });
});

describe('форма кадра message_new', () => {
  /* Имена сняты с живого кадра p1-send-frame.json; тела оттуда в тест не переносятся */
  const PAYLOAD_FIELDS = ['keys', 'group_chat_id', 'sync_id', 'payload', 'signature'];
  const KEY_ENTRY_FIELDS = ['key_id', 'key', 'algo'];
  const SIGNATURE_FIELDS = ['sign', 'sign_key_id', 'sign_algo'];

  it('множество имён полей совпадает с наблюдённым кадром', async () => {
    const message = await encryptOnBothRecipients();

    expect(Object.keys(message).sort()).toEqual([...PAYLOAD_FIELDS].sort());
    for (const entry of message.keys) {
      expect(Object.keys(entry).sort()).toEqual([...KEY_ENTRY_FIELDS].sort());
      expect(entry.algo).toBe('xsalsa20:xchacha20_aead_ietf');
    }
    expect(Object.keys(message.signature).sort()).toEqual([...SIGNATURE_FIELDS].sort());
  });
});

describe('отказы расшифровки', () => {
  async function makeEvent(): Promise<EncryptedEventRef> {
    return oracleEncrypt({
      innerEvent: INNER_EVENT,
      groupChatId: GROUP_CHAT_ID,
      syncId: SYNC_ID,
      senderPrivateKey: ring.sender.privateKey,
      senderKeyId: ring.sender.keyId,
      recipientPublicKey: ring.recipients[0].publicKey,
      recipientKeyId: ring.recipients[0].keyId,
    });
  }

  it('чужой sync_id в связанных данных даёт отказ на теле', async () => {
    const event = await makeEvent();
    const tampered: EncryptedEventRef = { ...event, sync_id: '11111111-1111-4111-8111-111111111111' };

    const error = await decryptEvent(tampered, {
      recipientPrivateKey: ring.recipients[0].privateKey,
      senderPublicKey: ring.sender.publicKey,
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(DecryptError);
    expect((error as DecryptError).stage).toBe('body');
    expect((error as DecryptError).syncId).toBe(tampered.sync_id);
  });

  it('чужой group_chat_id в связанных данных даёт отказ на теле', async () => {
    const event = await makeEvent();
    const tampered: EncryptedEventRef = {
      ...event,
      group_chat_id: '22222222-2222-4222-8222-222222222222',
    };

    const error = await decryptEvent(tampered, {
      recipientPrivateKey: ring.recipients[0].privateKey,
      senderPublicKey: ring.sender.publicKey,
    }).catch((thrown: unknown) => thrown);

    expect((error as DecryptError).stage).toBe('body');
  });

  it('приватный ключ другого получателя даёт отказ на обёртке', async () => {
    const event = await makeEvent();

    const error = await decryptEvent(event, {
      recipientPrivateKey: ring.recipients[1].privateKey,
      senderPublicKey: ring.sender.publicKey,
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(DecryptError);
    expect((error as DecryptError).stage).toBe('wrap');
    expect((error as DecryptError).keyId).toBe(ring.recipients[0].keyId);
  });

  it('открытое тело не JSON-объект даёт отказ на разборе', async () => {
    const event = oracleEncrypt({
      innerEvent: ['не', 'объект'] as unknown as Record<string, unknown>,
      groupChatId: GROUP_CHAT_ID,
      syncId: SYNC_ID,
      senderPrivateKey: ring.sender.privateKey,
      senderKeyId: ring.sender.keyId,
      recipientPublicKey: ring.recipients[0].publicKey,
      recipientKeyId: ring.recipients[0].keyId,
    });

    const error = await decryptEvent(event, {
      recipientPrivateKey: ring.recipients[0].privateKey,
      senderPublicKey: ring.sender.publicKey,
    }).catch((thrown: unknown) => thrown);

    expect((error as DecryptError).stage).toBe('json');
  });

  it('диагноз несёт идентификаторы и не несёт тел ключей', async () => {
    const event = await makeEvent();

    const error = (await decryptEvent(event, {
      recipientPrivateKey: ring.recipients[1].privateKey,
      senderPublicKey: ring.sender.publicKey,
    }).catch((thrown: unknown) => thrown)) as DecryptError;

    expect(error.message).toContain(ring.recipients[0].keyId);
    expect(error.message).toContain(GROUP_CHAT_ID);
    expect(error.message).toContain(SYNC_ID);
    expect(error.message).not.toContain(event.key.key);
    expect(error.message).not.toContain(event.payload);
    expect(error.message).not.toContain(ring.recipients[0].privateKeyEntry.body);
  });
});

describe('интеграция с KeyStore', () => {
  /** Заглушка порта: реализация живёт в чужой истории, тесту нужен только матч по id */
  function makeKeyStore(entries: Map<string, Uint8Array>): KeyStore {
    return {
      match: async (keyId) => entries.get(keyId),
      require: async (keyId) => {
        const found = entries.get(keyId);
        if (!found) {
          throw new KeyNotFoundError(keyId, [...entries.keys()]);
        }
        return found;
      },
    };
  }

  it('приватный ключ из require открывает событие', async () => {
    const fixture = await encryptInnerEvent({
      innerEvent: INNER_EVENT,
      groupChatId: GROUP_CHAT_ID,
      syncId: SYNC_ID,
      senderKeyId: ring.sender.keyId,
      senderPrivateKey: ring.sender.privateKey,
      recipient: ring.recipients[1],
    });
    const keyStore = makeKeyStore(
      new Map([[ring.recipients[1].keyId, ring.recipients[1].privateKey]]),
    );

    const recipientPrivateKey = await keyStore.require(fixture.event.key.key_id);
    const inner = await decryptEvent(fixture.event, {
      recipientPrivateKey,
      senderPublicKey: fixture.senderPublicKey,
    });

    expect(inner).toEqual(INNER_EVENT);
  });

  it('несовпадение идентификатора даёт KeyNotFoundError', async () => {
    const fixture = await encryptInnerEvent({
      innerEvent: INNER_EVENT,
      groupChatId: GROUP_CHAT_ID,
      syncId: SYNC_ID,
      senderKeyId: ring.sender.keyId,
      senderPrivateKey: ring.sender.privateKey,
      recipient: ring.recipients[0],
    });
    const keyStore = makeKeyStore(
      new Map([[ring.recipients[1].keyId, ring.recipients[1].privateKey]]),
    );

    await expect(keyStore.require(fixture.event.key.key_id)).rejects.toBeInstanceOf(
      KeyNotFoundError,
    );
  });
});

describe('подпись', () => {
  it('своя подпись проверяется своей проверкой и отвергает чужой ключ', async () => {
    const payloadBase64 = 'c2ludGV0aWNoZXNraXkgcGF5bG9hZA==';
    const other = sodium.crypto_sign_keypair();

    const signature = await signPayload(payloadBase64, ring.sign.privateKey);

    await expect(
      verifyPayloadSignature(payloadBase64, signature, ring.sign.publicKey),
    ).resolves.toBe(true);
    await expect(verifyPayloadSignature(payloadBase64, signature, other.publicKey)).resolves.toBe(
      false,
    );
    await expect(
      verifyPayloadSignature('ZHJ1Z29p', signature, ring.sign.publicKey),
    ).resolves.toBe(false);
  });

  it('битая подпись это ответ false, а не исключение', async () => {
    await expect(
      verifyPayloadSignature('cGF5bG9hZA==', 'не base64 и не подпись', ring.sign.publicKey),
    ).resolves.toBe(false);
  });
});

describe('изоляция от логов', () => {
  it('шифрование не пишет в stdout', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await encryptOnBothRecipients();
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
    }
  });
});
