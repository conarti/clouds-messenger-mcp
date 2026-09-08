/**
 * Сборка и отправка исходящего сообщения.
 *
 * ГЛАВНОЕ УТВЕРЖДЕНИЕ (precondition живой пробы): получатели обёртки контент-ключа
 * строятся ТОЛЬКО из `chat.keys`, их публичные тела приезжают из KDC, а локальный профиль
 * в состав получателей не попадает ни одним идентификатором. Живая проба Фазы 0 показала,
 * что вывод получателей из профиля даёт отказ `invalid_keys`, поэтому здесь проверяется не
 * «обёртка посчиталась», а откуда взялся её адресат.
 *
 * ВТОРОЕ УТВЕРЖДЕНИЕ: отправка идёт БЕЗ ПОВТОРА. Умолчание транспорта разрешает повтор,
 * потому что рассчитано на идемпотентное чтение, и класс отправки обязан передать запрет
 * явно, иначе обрыв соединения задвоит сообщение у собеседника.
 *
 * Крипто здесь настоящее: подложное доказывало бы только то, что работает подложное.
 * Подменены ровно две вещи: KDC отвечает стабом REST, а сокет считает кадры.
 */
import sodium from 'libsodium-wrappers-sumo';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { KeyMaterial } from '../../src/auth/AuthProvider.js';
import { FakeAuthProvider, FAKE_CTS_PUBLIC_KEY_ID, FAKE_RTS_PUBLIC_KEY_ID } from '../../src/auth/FakeAuthProvider.js';
import type { KeyStore } from '../../src/auth/keyStore.js';
import { SodiumCryptoService } from '../../src/crypto/service.js';
import type { ToolDeps } from '../../src/mcp/tools/deps.js';
import { normalizeChat, type ChatRecord } from '../../src/protocol/chatShape.js';
import {
  MESSAGE_NEW_EVENT,
  SenderKeyMissingError,
  buildMessageNewRequest,
  buildTextInnerEvent,
  sendMessageNew,
  type MessageNewRequest,
} from '../../src/protocol/mutations.js';
import type { KdcKey, RestClient } from '../../src/transport/types.js';
import type { PhoenixClient } from '../../src/transport/ws/types.js';
import { createLogger } from '../../src/util/logger.js';
import { makeKeyRing, type KeyRing } from '../helpers/cryptoFixtures.js';
import { MY_HUID, POLYGON_CHAT_ID, makeRawChat } from '../helpers/readFixtures.js';
import { createTestConfig } from '../helpers/testConfig.js';

const SYNC_ID = '00000000-0000-4000-8000-000000000001';
const MSG_ID = '00000000-0000-4000-8000-0000000000ff';

let ring: KeyRing;

function encode(bytes: Uint8Array): string {
  return sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
}

/** Обращение к хранилищу ключей на пути отправки это нарушение: получатели идут из чата */
function forbidden(what: string): () => never {
  return () => {
    throw new Error(`${what}: на пути отправки обращаться сюда запрещено`);
  };
}

interface Harness {
  deps: ToolDeps;
  chat: ChatRecord;
  kdcRequests: string[][];
  wsCalls: Array<{ topic: string; event: string; payload: unknown; options: unknown }>;
  wsResponse: { value: unknown };
}

function keyMaterialOf(withSenderKey: boolean): KeyMaterial {
  const signKeys = { privateBody: encode(ring.sign.privateKey), publicId: ring.sign.keyId };
  return {
    privateKeys: withSenderKey ? { cts: ring.sender.privateKeyEntry } : {},
    signKeys,
    wsParams: { keyId: ring.sender.keyId, instanceId: 'test-instance-id' },
  };
}

function createHarness(options: { withSenderKey?: boolean } = {}): Harness {
  const publicBodies = new Map<string, Uint8Array>([
    [ring.sender.keyId, ring.sender.publicKey],
    [ring.recipients[0].keyId, ring.recipients[0].publicKey],
    [ring.recipients[1].keyId, ring.recipients[1].publicKey],
  ]);

  const kdcRequests: string[][] = [];
  const rest: RestClient = {
    getJson: vi.fn(forbidden('rest.getJson')),
    async getKdcKeys(ids: readonly string[]): Promise<KdcKey[]> {
      kdcRequests.push([...ids]);
      return ids.flatMap((keyId) => {
        const body = publicBodies.get(keyId);
        return body === undefined ? [] : [{ key_id: keyId, algo: 'x25519', kind: 'cts', body: encode(body) }];
      });
    },
  };

  const wsCalls: Array<{ topic: string; event: string; payload: unknown; options: unknown }> = [];
  const wsResponse: { value: unknown } = { value: { inserted_at: '2026-09-08T07:10:00.000Z' } };
  const ws: PhoenixClient = {
    async request<T>(topic: string, event: string, payload: unknown, requestOptions?: unknown): Promise<T> {
      wsCalls.push({ topic, event, payload, options: requestOptions });
      return wsResponse.value as T;
    },
    close: vi.fn(forbidden('ws.close')),
  };

  const keyStore: KeyStore = {
    match: vi.fn(forbidden('keyStore.match')),
    require: vi.fn(forbidden('keyStore.require')),
  };

  const logger = createLogger({ level: 'error' });
  const config = createTestConfig();
  const auth = new FakeAuthProvider({
    huid: MY_HUID,
    keyMaterial: keyMaterialOf(options.withSenderKey ?? true),
  });
  const crypto = new SodiumCryptoService({ rest, logger });

  const chat = normalizeChat(
    makeRawChat({
      chatId: POLYGON_CHAT_ID,
      name: 'Избранное',
      chatType: 'notes',
      keys: [ring.recipients[0].keyId, ring.recipients[1].keyId],
    }),
  );
  if (chat === undefined) {
    throw new Error('фикстура чата не нормализовалась');
  }

  return {
    deps: { ws, rest, auth, crypto, keyStore, config, logger },
    chat,
    kdcRequests,
    wsCalls,
    wsResponse,
  };
}

beforeAll(async () => {
  await sodium.ready;
  ring = await makeKeyRing();
});

describe('внутреннее событие текста', () => {
  it('собирается ровно в наблюдённой живьём форме, без пропусков и без лишних полей', () => {
    const inner = buildTextInnerEvent({
      huid: MY_HUID,
      groupChatId: POLYGON_CHAT_ID,
      text: 'привет',
      msgId: MSG_ID,
      timestamp: '2026-09-08T07:10:00.000Z',
    });

    expect(inner).toEqual({
      type: 'text',
      msg_id: MSG_ID,
      from: MY_HUID,
      timestamp: '2026-09-08T07:10:00.000Z',
      group_chat_id: POLYGON_CHAT_ID,
      lat: 0,
      lng: 0,
      link_meta_disabled: false,
      stealth_forwarding: false,
      body: 'привет',
    });
  });
});

describe('сборка кадра отправки', () => {
  it('получатели строятся из ключей чата, а локальные идентификаторы профиля не подставляются', async () => {
    const harness = createHarness();

    const request = await buildMessageNewRequest({
      chat: harness.chat,
      text: 'привет',
      syncId: SYNC_ID,
      deps: harness.deps,
    });

    /* KDC спрошен РОВНО о ключах чата: ни одного лишнего идентификатора не добавлено */
    expect(harness.kdcRequests).toEqual([[ring.recipients[0].keyId, ring.recipients[1].keyId]]);
    expect(request.payload.keys.map((entry) => entry.key_id)).toEqual([
      ring.recipients[0].keyId,
      ring.recipients[1].keyId,
    ]);

    const serialized = JSON.stringify(request.payload);
    expect(serialized).not.toContain(FAKE_CTS_PUBLIC_KEY_ID);
    expect(serialized).not.toContain(FAKE_RTS_PUBLIC_KEY_ID);
    expect(serialized).not.toContain(ring.sender.keyId);
  });

  it('хранилище ключей на этом пути не участвует', async () => {
    const harness = createHarness();

    await buildMessageNewRequest({
      chat: harness.chat,
      text: 'привет',
      syncId: SYNC_ID,
      deps: harness.deps,
    });

    expect(harness.deps.keyStore.match).not.toHaveBeenCalled();
    expect(harness.deps.keyStore.require).not.toHaveBeenCalled();
  });

  it('адресует топик чата, несёт идентификатор отправки и подписан ключом профиля', async () => {
    const harness = createHarness();

    const request = await buildMessageNewRequest({
      chat: harness.chat,
      text: 'привет',
      syncId: SYNC_ID,
      deps: harness.deps,
    });

    expect(request.topic).toBe(`groupchat:${POLYGON_CHAT_ID}`);
    expect(request.event).toBe(MESSAGE_NEW_EVENT);
    expect(request.payload.group_chat_id).toBe(POLYGON_CHAT_ID);
    expect(request.payload.sync_id).toBe(SYNC_ID);
    expect(request.payload.signature.sign_key_id).toBe(ring.sign.keyId);
    expect(request.payload.signature.sign_algo).toBe('ed25519');
    expect(request.payload.payload.length).toBeGreaterThan(0);
  });

  it('без приватного ключа обмена отправка отказывает с диагнозом, а не молча берёт другой', async () => {
    const harness = createHarness({ withSenderKey: false });

    await expect(
      buildMessageNewRequest({
        chat: harness.chat,
        text: 'привет',
        syncId: SYNC_ID,
        deps: harness.deps,
      }),
    ).rejects.toBeInstanceOf(SenderKeyMissingError);
    expect(harness.kdcRequests).toEqual([]);
  });
});

describe('отправка кадра', () => {
  it('запрещает повтор явно и отдаёт метку сервера', async () => {
    const harness = createHarness();
    const request = await buildMessageNewRequest({
      chat: harness.chat,
      text: 'привет',
      syncId: SYNC_ID,
      deps: harness.deps,
    });

    const ack = await sendMessageNew(harness.deps, request);

    expect(harness.wsCalls).toHaveLength(1);
    expect(harness.wsCalls[0]).toMatchObject({
      topic: `groupchat:${POLYGON_CHAT_ID}`,
      event: MESSAGE_NEW_EVENT,
      payload: request.payload,
      options: { retry: false },
    });
    expect(ack.inserted_at).toBe('2026-09-08T07:10:00.000Z');
  });

  it('молчание сервера про метку это отсутствие поля, а не выдуманное значение', async () => {
    const harness = createHarness();
    harness.wsResponse.value = {};
    const request: MessageNewRequest = await buildMessageNewRequest({
      chat: harness.chat,
      text: 'привет',
      syncId: SYNC_ID,
      deps: harness.deps,
    });

    const ack = await sendMessageNew(harness.deps, request);

    expect(Object.keys(ack)).toEqual([]);
  });
});
