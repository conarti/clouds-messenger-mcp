import { beforeAll, describe, expect, it, vi } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import type { KeyStore } from '../../src/auth/keyStore.js';
import { KdcKeys, KeyResolutionError } from '../../src/crypto/keys.js';
import type { KdcKey, RestClient } from '../../src/transport/types.js';
import { makeKeyRing, type KeyRing } from '../helpers/cryptoFixtures.js';

/**
 * Заглушка REST: отдаёт публичные тела в ПЕРЕВЁРНУТОМ порядке, как это делал живой KDC.
 * Порядок ответа не должен влиять на порядок результата.
 */
function makeRest(bodies: Map<string, string>) {
  const getKdcKeys = vi.fn(async (ids: readonly string[]): Promise<KdcKey[]> =>
    [...ids]
      .reverse()
      .flatMap((id) => {
        const body = bodies.get(id);
        return body === undefined ? [] : [{ key_id: id, algo: 'xsalsa20', kind: 'cts', body }];
      }),
  );
  const rest: RestClient = {
    getJson: vi.fn(async () => {
      throw new Error('getJson в резолве ключей не участвует');
    }),
    getKdcKeys,
  };
  return { rest, getKdcKeys };
}

function encodeBody(bytes: Uint8Array): string {
  return sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
}

let ring: KeyRing;
let known: Map<string, string>;

beforeAll(async () => {
  await sodium.ready;
  ring = await makeKeyRing();
  known = new Map([
    [ring.recipients[0].keyId, encodeBody(ring.recipients[0].publicKey)],
    [ring.recipients[1].keyId, encodeBody(ring.recipients[1].publicKey)],
    [ring.sender.keyId, encodeBody(ring.sender.publicKey)],
  ]);
});

describe('резолв получателей', () => {
  it('отдаёт тела в порядке запроса, а не в порядке ответа KDC', async () => {
    const { rest, getKdcKeys } = makeRest(known);
    const keys = new KdcKeys(rest);

    const resolved = await keys.resolveRecipientPublicKeys([
      ring.recipients[0].keyId,
      ring.recipients[1].keyId,
    ]);

    expect(resolved.map((entry) => entry.keyId)).toEqual([
      ring.recipients[0].keyId,
      ring.recipients[1].keyId,
    ]);
    expect(resolved[0]?.body).toEqual(ring.recipients[0].publicKey);
    expect(resolved[1]?.body).toEqual(ring.recipients[1].publicKey);
    expect(getKdcKeys).toHaveBeenCalledTimes(1);
  });

  it('спрашивает KDC только про незакэшированные идентификаторы', async () => {
    const { rest, getKdcKeys } = makeRest(known);
    const keys = new KdcKeys(rest);

    await keys.resolveRecipientPublicKeys([ring.recipients[0].keyId]);
    await keys.resolveRecipientPublicKeys([ring.recipients[0].keyId, ring.recipients[1].keyId]);
    await keys.resolveRecipientPublicKeys([ring.recipients[1].keyId]);

    expect(getKdcKeys.mock.calls.map((call) => call[0])).toEqual([
      [ring.recipients[0].keyId],
      [ring.recipients[1].keyId],
    ]);
  });

  it('повторы в запросе не удваивают обращение к KDC', async () => {
    const { rest, getKdcKeys } = makeRest(known);
    const keys = new KdcKeys(rest);

    const resolved = await keys.resolveRecipientPublicKeys([
      ring.recipients[0].keyId,
      ring.recipients[0].keyId,
    ]);

    expect(resolved).toHaveLength(2);
    expect(getKdcKeys).toHaveBeenCalledWith([ring.recipients[0].keyId]);
  });

  it('отсутствие ключа в ответе KDC это отказ с перечислением ненайденных', async () => {
    const { rest } = makeRest(known);
    const keys = new KdcKeys(rest);

    const error = await keys
      .resolveRecipientPublicKeys([ring.recipients[0].keyId, 'ключ-которого-нет'])
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(KeyResolutionError);
    expect((error as KeyResolutionError).missingKeyIds).toEqual(['ключ-которого-нет']);
    expect((error as KeyResolutionError).message).toContain('ключ-которого-нет');
  });

  it('публичная половина отправителя идёт через тот же кэш', async () => {
    const { rest, getKdcKeys } = makeRest(known);
    const keys = new KdcKeys(rest);

    await keys.resolveRecipientPublicKeys([ring.sender.keyId]);
    const senderBody = await keys.senderPublicKey(ring.sender.keyId);

    expect(senderBody).toEqual(ring.sender.publicKey);
    expect(getKdcKeys).toHaveBeenCalledTimes(1);
  });

  it('неизвестный отправитель это тот же отказ резолва', async () => {
    const { rest } = makeRest(known);
    const keys = new KdcKeys(rest);

    await expect(keys.senderPublicKey('отправитель-которого-нет')).rejects.toBeInstanceOf(
      KeyResolutionError,
    );
  });
});

describe('предусловие: получатели только из списка чата', () => {
  it('спрашивает ровно переданные идентификаторы и не трогает KeyStore', async () => {
    /* Заглушка хранилища локальных ключей: в резолве получателей она участвовать не должна */
    const keyStore: KeyStore = { match: vi.fn(), require: vi.fn() };
    const foreignKeyIds = ['чужой-ключ-a', 'чужой-ключ-b'];
    const foreignBodies = new Map([
      [foreignKeyIds[0] ?? '', encodeBody(sodium.crypto_box_keypair().publicKey)],
      [foreignKeyIds[1] ?? '', encodeBody(sodium.crypto_box_keypair().publicKey)],
    ]);
    const { rest, getKdcKeys } = makeRest(foreignBodies);
    const keys = new KdcKeys(rest);

    const resolved = await keys.resolveRecipientPublicKeys(foreignKeyIds);

    expect(getKdcKeys).toHaveBeenCalledWith(foreignKeyIds);
    expect(resolved.map((entry) => entry.keyId)).toEqual(foreignKeyIds);
    /* Тела приехали из KDC, а не подставились из локального материала */
    for (const entry of resolved) {
      expect(encodeBody(entry.body)).toBe(foreignBodies.get(entry.keyId));
    }
    expect(keyStore.match).not.toHaveBeenCalled();
    expect(keyStore.require).not.toHaveBeenCalled();
  });

  it('локальный ключ не подставляется под чужой идентификатор', async () => {
    const { rest } = makeRest(new Map());
    const keys = new KdcKeys(rest);

    await expect(
      keys.resolveRecipientPublicKeys([ring.recipients[0].keyId]),
    ).rejects.toBeInstanceOf(KeyResolutionError);
  });
});
