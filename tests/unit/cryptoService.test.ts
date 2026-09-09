import { beforeAll, describe, expect, it, vi } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import { SodiumCryptoService } from '../../src/crypto/service.js';
import { createLogger } from '../../src/util/logger.js';
import type { KdcKey, RestClient } from '../../src/transport/types.js';
import { encryptInnerEvent, makeKeyRing, type KeyRing } from '../helpers/cryptoFixtures.js';

const GROUP_CHAT_ID = '00000000-0000-4000-8000-00000000cha7';
const SYNC_ID = '00000000-0000-4000-8000-0000000005c1';
const INNER_EVENT = { type: 'text', body: 'синтетический текст пробы' };

let ring: KeyRing;

beforeAll(async () => {
  await sodium.ready;
  ring = await makeKeyRing();
});

function makeService() {
  const getKdcKeys = vi.fn(
    async (ids: readonly string[]): Promise<KdcKey[]> =>
      ids.flatMap((id) => {
        const recipient = ring.recipients.find((candidate) => candidate.keyId === id);
        return recipient === undefined
          ? []
          : [
              {
                key_id: id,
                algo: 'xsalsa20',
                kind: 'cts',
                body: sodium.to_base64(recipient.publicKey, sodium.base64_variants.ORIGINAL),
              },
            ];
      }),
  );
  const rest: RestClient = {
    getJson: vi.fn(async () => {
      throw new Error('getJson здесь не участвует');
    }),
    postJson: vi.fn(async () => {
      throw new Error('postJson здесь не участвует');
    }),
    getKdcKeys,
  };
  return {
    service: new SodiumCryptoService({ rest, logger: createLogger({ level: 'error' }) }),
    getKdcKeys,
  };
}

describe('SodiumCryptoService', () => {
  it('шифрует на получателей, резолвленных через KDC, и читает своё же событие', async () => {
    const { service, getKdcKeys } = makeService();

    const recipients = await service.keys.resolveRecipientPublicKeys([
      ring.recipients[0].keyId,
      ring.recipients[1].keyId,
    ]);
    const message = await service.encryptMessage({
      innerEvent: INNER_EVENT,
      groupChatId: GROUP_CHAT_ID,
      syncId: SYNC_ID,
      recipients,
      senderPrivateKey: ring.sender.privateKey,
      signPrivateKey: ring.sign.privateKey,
      signKeyId: ring.sign.keyId,
    });

    expect(getKdcKeys).toHaveBeenCalledTimes(1);
    expect(message.keys.map((entry) => entry.key_id)).toEqual([
      ring.recipients[0].keyId,
      ring.recipients[1].keyId,
    ]);

    const entry = message.keys[0];
    const inner = await service.decryptEvent(
      {
        group_chat_id: message.group_chat_id,
        sync_id: message.sync_id,
        sender_key_id: ring.sender.keyId,
        key: { key_id: entry?.key_id ?? '', key: entry?.key ?? '', algo: entry?.algo ?? '' },
        payload: message.payload,
      },
      {
        recipientPrivateKey: ring.recipients[0].privateKey,
        senderPublicKey: ring.sender.publicKey,
      },
    );

    expect(inner).toEqual(INNER_EVENT);
  });

  it('расшифровывает событие истории и молчит в stdout', async () => {
    const { service } = makeService();
    const fixture = await encryptInnerEvent({
      innerEvent: INNER_EVENT,
      groupChatId: GROUP_CHAT_ID,
      syncId: SYNC_ID,
      senderKeyId: ring.sender.keyId,
      senderPrivateKey: ring.sender.privateKey,
      recipient: ring.recipients[0],
    });
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    try {
      const inner = await service.decryptEvent(fixture.event, {
        recipientPrivateKey: ring.recipients[0].privateKey,
        senderPublicKey: fixture.senderPublicKey,
      });
      expect(inner).toEqual(INNER_EVENT);
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
    }
  });
});
