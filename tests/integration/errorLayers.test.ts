/**
 * Три слоя ошибок от кадра до выдачи MCP.
 *
 * Слои проверяются через настоящий транспорт, а не на мапперах: перепутать их между собой
 * легко (один и тот же код в разных слоях значит разное), и цена путаницы это ремонт не
 * того места. Подмен ровно две: адрес сокета ведёт в локальный Phoenix-мок, а KDC отвечает
 * подложным fetch. Крипто, разбор форм и регистрация инструментов настоящие.
 *
 * Второй сюжет этого файла важнее первого: отказ РАСШИФРОВКИ не роняет страницу истории.
 * Событие остаётся в выдаче с пометкой слоя, потому что молча исчезнувшее сообщение хуже
 * нечитаемого: вызывающий увидит дыру в переписке и примет её за факт.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import sodium from 'libsodium-wrappers-sumo';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { KeyMaterial } from '../../src/auth/AuthProvider.js';
import { FakeAuthProvider, createFakeKeyMaterial } from '../../src/auth/FakeAuthProvider.js';
import { AuthKeyStore } from '../../src/auth/keyStore.js';
import { SodiumCryptoService } from '../../src/crypto/service.js';
import type { GetHistoryResult } from '../../src/mcp/tools/getHistory.js';
import { CHAT_LIST_EVENT } from '../../src/protocol/chatList.js';
import { EVENTS_HISTORY_EVENT } from '../../src/protocol/history.js';
import { createServer } from '../../src/server.js';
import { HttpRestClient } from '../../src/transport/RestClient.js';
import { PhoenixWsClient } from '../../src/transport/ws/PhoenixClient.js';
import { createLogger } from '../../src/util/logger.js';
import { makeKeyRing, type KeyRing } from '../helpers/cryptoFixtures.js';
import { MockPhoenix, startMockPhoenix } from '../helpers/mockPhoenix.js';
import {
  MY_HUID,
  POLYGON_CHAT_ID,
  makeHistoryEvent,
  makeInnerText,
  makeRawChat,
} from '../helpers/readFixtures.js';
import { createTestConfig } from '../helpers/testConfig.js';

/** Код, которого нет ни в одном справочнике: им проверяется отказ гадать */
const UNKNOWN_CODE = 'quantum_flux';
const SYNC_ID = '00000000-0000-4000-8000-000000000001';
const EVENT_TIME = '2026-09-08T07:01:00.000Z';

type HistoryBehavior = 'ok' | 'invalid_keys' | 'unknown_code' | 'drop';

let ring: KeyRing;
let mock: MockPhoenix;
let ws: PhoenixWsClient;
let server: McpServer;
let client: Client;
let historyEvents: Record<string, unknown>[];
let historyBehavior: HistoryBehavior;
/** Статус ответа KDC: им проверяется слой rest на пути расшифровки */
let kdcStatus: number;

const CHATS = [makeRawChat({ chatId: POLYGON_CHAT_ID, name: 'Избранное', chatType: 'notes' })];

/**
 * Одно текстовое событие. `senderPrivateKey` вынесен в параметр намеренно: подставив
 * ЧУЖУЮ приватную половину при том же `sender_key_id`, получаем ровно тот случай, ради
 * которого заведён отказ обёртки, и получаем его настоящим крипто, а не подменой.
 */
async function makeEvent(senderPrivateKey: Uint8Array): Promise<Record<string, unknown>> {
  return makeHistoryEvent({
    groupChatId: POLYGON_CHAT_ID,
    syncId: SYNC_ID,
    insertedAt: EVENT_TIME,
    sender: MY_HUID,
    senderKeyId: ring.sender.keyId,
    senderPrivateKey,
    recipient: ring.recipients[0],
    inner: makeInnerText({
      msgId: SYNC_ID,
      from: MY_HUID,
      timestamp: EVENT_TIME,
      groupChatId: POLYGON_CHAT_ID,
      body: 'первое сообщение',
    }),
  });
}

/** KDC отдаёт публичную половину отправителя либо отказ выбранным статусом */
function kdcFetch(): typeof fetch {
  return (async () => {
    if (kdcStatus !== 200) {
      return new Response('internal error', { status: kdcStatus });
    }
    return new Response(
      JSON.stringify({
        result: [
          {
            key_id: ring.sender.keyId,
            algo: 'x25519',
            kind: 'cts',
            body: sodium.to_base64(ring.sender.publicKey, sodium.base64_variants.ORIGINAL),
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
}

function keyMaterialForRing(): KeyMaterial {
  const base = createFakeKeyMaterial();
  return {
    privateKeys: { cts: ring.recipients[0].privateKeyEntry },
    signKeys: base.signKeys,
    wsParams: { keyId: ring.recipients[0].keyId, instanceId: 'test-instance-id' },
  };
}

async function callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  if (result.isError === true) {
    throw new Error(`инструмент ${name} ответил ошибкой: ${content[0]?.text ?? ''}`);
  }
  return JSON.parse(content[0]?.text ?? 'null') as T;
}

async function callToolExpectingError(name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  expect(result.isError).toBe(true);
  return content[0]?.text ?? '';
}

beforeAll(async () => {
  await sodium.ready;
  ring = await makeKeyRing();
});

beforeEach(async () => {
  historyBehavior = 'ok';
  kdcStatus = 200;
  historyEvents = [await makeEvent(ring.sender.privateKey)];
  mock = await startMockPhoenix();

  mock.respondTo(CHAT_LIST_EVENT, () => ({ status: 'ok', response: { [CHAT_LIST_EVENT]: CHATS } }));
  mock.respondTo(EVENTS_HISTORY_EVENT, (_frame, connection) => {
    if (historyBehavior === 'invalid_keys') {
      return { status: 'error', response: { error: 'invalid_keys' } };
    }
    if (historyBehavior === 'unknown_code') {
      return { status: 'error', response: { error: UNKNOWN_CODE } };
    }
    if (historyBehavior === 'drop') {
      /* Обрыв вместо ответа: сервер молчит не потому, что думает, а потому, что его нет */
      connection.socket.terminate();
      return undefined;
    }
    return { status: 'ok', response: { history: [...historyEvents] } };
  });

  const logger = createLogger({ level: 'error' });
  const config = createTestConfig({
    protocol: { wsUrl: mock.url },
    ws: {
      authenticateTimeoutMs: 300,
      authenticateAttempts: 2,
      requestTimeoutMs: 1_000,
      /* Один заход: проверяется исчерпанный бюджет, а не сама возможность повтора */
      reconnectAttempts: 1,
      reconnectBaseDelayMs: 10,
      reconnectMaxDelayMs: 40,
      heartbeatIntervalMs: 60_000,
    },
  });
  const auth = new FakeAuthProvider({ keyMaterial: keyMaterialForRing() });
  ws = new PhoenixWsClient({ auth, config, logger });
  const rest = new HttpRestClient({ auth, config, logger, fetchImplementation: kdcFetch() });
  const crypto = new SodiumCryptoService({ rest, logger });
  const keyStore = new AuthKeyStore(auth);

  server = createServer({
    config,
    logger,
    deps: { ws, rest, auth, crypto, keyStore, config, logger },
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'clouds-messenger-mcp-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  await client.close();
  await server.close();
  await ws.close();
  await mock.close();
});

describe('слой phoenix: прикладной отказ события', () => {
  it('известный код доезжает до MCP с тегом слоя и человеческим пояснением', async () => {
    historyBehavior = 'invalid_keys';

    const text = await callToolExpectingError('get_history', { chat: 'Избранное' });

    expect(text).toContain('get_history:');
    expect(text).toContain('[phoenix] invalid_keys');
    expect(text).toContain('перечитайте список чатов');
  });

  it('незнакомый код не сводится к своему словарю и уезжает как есть', async () => {
    historyBehavior = 'unknown_code';

    const text = await callToolExpectingError('get_history', { chat: 'Избранное' });

    expect(text).toContain(`[phoenix] unknown code: ${UNKNOWN_CODE}`);
  });
});

describe('слой phoenix: обрыв соединения', () => {
  it('обрыв с исчерпанным бюджетом это отказ с кодом транспорта, а не пустая выдача', async () => {
    historyBehavior = 'drop';

    const text = await callToolExpectingError('get_history', { chat: 'Избранное' });

    expect(text).toContain('[phoenix] transport_closed');
  });
});

describe('слой rest: отказ KDC на пути расшифровки', () => {
  it('пятисотка KDC приезжает тегом rest и номером статуса, а не тегом крипто', async () => {
    kdcStatus = 500;

    const payload = await callTool<GetHistoryResult>('get_history', { chat: 'Избранное' });
    if (payload.status !== 'ok') {
      throw new Error('ожидалась успешная выдача');
    }

    expect(payload.messages[0]?.decrypt_error).toContain('[rest] 500');
    expect(payload.messages[0]?.decrypt_error).toContain('HTTP 500');
  });
});

describe('слой client: отказ расшифровки не роняет страницу', () => {
  it('событие с чужим ключом остаётся в выдаче с пометкой слоя client', async () => {
    historyEvents = [await makeEvent(ring.recipients[1].privateKey)];

    const payload = await callTool<GetHistoryResult>('get_history', { chat: 'Избранное' });
    if (payload.status !== 'ok') {
      throw new Error('ожидалась успешная выдача');
    }

    expect(payload.messages).toHaveLength(1);
    expect(payload.messages[0]?.message_id).toBe(SYNC_ID);
    expect(payload.messages[0]?.decrypt_error).toContain('[client] decrypt_wrap');
    expect(payload.messages[0]?.text).toBeUndefined();
  });

  it('нечитаемое событие не превращается в дыру: адрес и метки на месте', async () => {
    historyEvents = [await makeEvent(ring.recipients[1].privateKey)];

    const payload = await callTool<GetHistoryResult>('get_history', { chat: 'Избранное' });
    if (payload.status !== 'ok') {
      throw new Error('ожидалась успешная выдача');
    }

    expect(payload.messages[0]?.chat_id).toBe(POLYGON_CHAT_ID);
    expect(payload.next_before).toBe(SYNC_ID);
  });
});
