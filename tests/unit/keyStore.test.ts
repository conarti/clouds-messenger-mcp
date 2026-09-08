import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { KeyMaterial } from '../../src/auth/AuthProvider.js';
import { AuthKeyStore, KeyNotFoundError } from '../../src/auth/keyStore.js';

/** Синтетические тела: живой ключ в исходниках остался бы в истории и в любом форке */
const CTS_BODY = randomBytes(32).toString('base64');
const RTS_BODY = randomBytes(32).toString('base64');

const CTS_KEY_ID = 'cts-public-key-id';
const RTS_KEY_ID = 'rts-public-key-id';

function keyMaterial(overrides: Partial<KeyMaterial['privateKeys']> = {}): KeyMaterial {
  return {
    privateKeys: {
      cts: { body: CTS_BODY, publicKeyId: CTS_KEY_ID },
      rts: { body: RTS_BODY, publicKeyId: RTS_KEY_ID },
      ...overrides,
    },
    signKeys: { privateBody: randomBytes(64).toString('base64'), publicId: 'sign-public-key-id' },
    wsParams: { keyId: CTS_KEY_ID, instanceId: 'instance-id' },
  };
}

function store(material: KeyMaterial = keyMaterial()): AuthKeyStore {
  return new AuthKeyStore({ getKeyMaterial: async () => material });
}

function decoded(body: string): Uint8Array {
  return Uint8Array.from(Buffer.from(body, 'base64'));
}

describe('match', () => {
  it('находит ключ обмена cts по идентификатору публичной половины', async () => {
    await expect(store().match(CTS_KEY_ID)).resolves.toEqual(decoded(CTS_BODY));
  });

  it('находит ключ обмена rts: вид ключа заранее неизвестен, перебираются оба', async () => {
    await expect(store().match(RTS_KEY_ID)).resolves.toEqual(decoded(RTS_BODY));
  });

  it('несовпадение это штатный ответ, а не отказ', async () => {
    await expect(store().match('чужой-key-id')).resolves.toBeUndefined();
  });

  it('отсутствующий вид ключа не мешает найти присутствующий', async () => {
    const material: KeyMaterial = keyMaterial();
    delete material.privateKeys.rts;

    await expect(store(material).match(CTS_KEY_ID)).resolves.toEqual(decoded(CTS_BODY));
    await expect(store(material).match(RTS_KEY_ID)).resolves.toBeUndefined();
  });
});

describe('require', () => {
  it('отдаёт байты найденного ключа', async () => {
    await expect(store().require(RTS_KEY_ID)).resolves.toEqual(decoded(RTS_BODY));
  });

  it('на несовпадении бросает отказ с искомым и всеми известными идентификаторами', async () => {
    const error = await store()
      .require('чужой-key-id')
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );

    expect(error).toBeInstanceOf(KeyNotFoundError);
    const failure = error as KeyNotFoundError;
    expect(failure.keyId).toBe('чужой-key-id');
    expect(failure.knownPublicKeyIds).toEqual([CTS_KEY_ID, RTS_KEY_ID]);
    expect(failure.message).toContain('чужой-key-id');
    expect(failure.message).toContain(CTS_KEY_ID);
    expect(failure.message).toContain(RTS_KEY_ID);
  });

  it('в диагноз не попадают тела ключей', async () => {
    const error = await store()
      .require('чужой-key-id')
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
    if (!(error instanceof KeyNotFoundError)) {
      throw new Error('ожидался KeyNotFoundError');
    }

    expect(error.message).not.toContain(CTS_BODY);
    expect(error.message).not.toContain(RTS_BODY);
  });
});
