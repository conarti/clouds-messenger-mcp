/**
 * Сборка боевого сервера MCP для проверок инструментов чтения.
 *
 * Настоящими здесь являются все слои, кроме двух подмен: адрес сокета ведёт в локальный
 * Phoenix-мок, а KDC отвечает подложным fetch. Клиент сокета, REST-клиент, libsodium,
 * хранилище ключей, разбор форм и регистрация инструментов боевые: расшифровка на
 * подложном крипто доказывала бы только то, что подложное крипто работает.
 *
 * Живёт отдельным помощником, потому что одну и ту же сборку заводят четыре проверки
 * инструментов. Разъехавшиеся копии сборки означали бы, что проверки гоняют разные серверы
 * и сравнивать их выдачу нельзя.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import sodium from 'libsodium-wrappers-sumo';
import { expect } from 'vitest';
import type { KeyMaterial } from '../../src/auth/AuthProvider.js';
import { FakeAuthProvider } from '../../src/auth/FakeAuthProvider.js';
import { AuthKeyStore } from '../../src/auth/keyStore.js';
import type { Config, ConfigOverrides } from '../../src/config/types.js';
import { SodiumCryptoService } from '../../src/crypto/service.js';
import { CHAT_LIST_EVENT, UNREAD_COUNTERS_EVENT } from '../../src/protocol/chatList.js';
import { createServer } from '../../src/server.js';
import { HttpRestClient } from '../../src/transport/RestClient.js';
import { PhoenixWsClient } from '../../src/transport/ws/PhoenixClient.js';
import { createLogger } from '../../src/util/logger.js';
import type { KeyRing } from './cryptoFixtures.js';
import { MockPhoenix, startMockPhoenix } from './mockPhoenix.js';
import { createTestConfig } from './testConfig.js';

export interface ToolServerOptions {
  ring: KeyRing;
  /** Сырые записи чатов: их отдаёт подложный сервер на запрос списка */
  chats: Record<string, unknown>[];
  configOverrides?: ConfigOverrides;
}

export interface ToolServer {
  mock: MockPhoenix;
  config: Config;
  auth: FakeAuthProvider;
  callTool<T>(name: string, args: Record<string, unknown>): Promise<T>;
  callToolExpectingError(name: string, args: Record<string, unknown>): Promise<string>;
  listToolNames(): Promise<string[]>;
  close(): Promise<void>;
}

/**
 * KDC отдаёт публичные половины всего кольца.
 *
 * Отправителя спрашивает чтение: без его публичной половины обёртка контент-ключа
 * входящего события не открывается. Получателей спрашивает отправка: их идентификаторы
 * приезжают в `chat.keys`, и без тел кадр не собрать.
 */
function kdcFetch(ring: KeyRing): typeof fetch {
  const publicKeys = [ring.sender, ...ring.recipients].map((pair) => ({
    key_id: pair.keyId,
    algo: 'x25519',
    kind: 'cts',
    body: sodium.to_base64(pair.publicKey, sodium.base64_variants.ORIGINAL),
  }));
  return (async () =>
    new Response(JSON.stringify({ result: publicKeys }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
}

function keyMaterialForRing(ring: KeyRing): KeyMaterial {
  return {
    /* Получатель события это мой cts-ключ: именно его ищет хранилище по key_id конверта */
    privateKeys: { cts: ring.recipients[0].privateKeyEntry },
    /* Ключ подписи настоящий: с синтетическим телом подпись исходящего кадра непроверяема */
    signKeys: {
      privateBody: sodium.to_base64(ring.sign.privateKey, sodium.base64_variants.ORIGINAL),
      publicId: ring.sign.keyId,
    },
    wsParams: { keyId: ring.recipients[0].keyId, instanceId: 'test-instance-id' },
  };
}

export async function startToolServer(options: ToolServerOptions): Promise<ToolServer> {
  await sodium.ready;
  const mock = await startMockPhoenix();

  mock.respondTo(CHAT_LIST_EVENT, () => ({
    status: 'ok',
    response: { [CHAT_LIST_EVENT]: options.chats },
  }));
  /*
   * Счётчики непрочитанного здесь всегда пустые: адресация чата их не спрашивает, а
   * инструменты этой сборки идут именно через адресацию. Ответчик всё равно заведён, чтобы
   * вызов списка чатов не повис на молчании подложного сервера.
   */
  mock.respondTo(UNREAD_COUNTERS_EVENT, () => ({
    status: 'ok',
    response: { unread_counters: [] },
  }));

  const logger = createLogger({ level: 'error' });
  const config = createTestConfig({
    ...options.configOverrides,
    protocol: { ...options.configOverrides?.protocol, wsUrl: mock.url },
    ws: {
      authenticateTimeoutMs: 300,
      authenticateAttempts: 2,
      requestTimeoutMs: 1_000,
      reconnectAttempts: 2,
      reconnectBaseDelayMs: 10,
      reconnectMaxDelayMs: 40,
      heartbeatIntervalMs: 60_000,
      ...options.configOverrides?.ws,
    },
  });

  const auth = new FakeAuthProvider({ keyMaterial: keyMaterialForRing(options.ring) });
  const ws = new PhoenixWsClient({ auth, config, logger });
  const rest = new HttpRestClient({ auth, config, logger, fetchImplementation: kdcFetch(options.ring) });
  const crypto = new SodiumCryptoService({ rest, logger });
  const keyStore = new AuthKeyStore(auth);

  const server: McpServer = createServer({
    config,
    logger,
    deps: { ws, rest, auth, crypto, keyStore, config, logger },
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'clouds-messenger-mcp-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  /** Текст первого блока ответа: форма результата у SDK это союз, и разбор идёт по факту */
  const textOf = (result: unknown): string => {
    const content = (result as { content?: Array<{ text?: string }> }).content;
    return content?.[0]?.text ?? '';
  };

  return {
    mock,
    config,
    auth,
    async callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
      const result = await client.callTool({ name, arguments: args });
      if (result.isError === true) {
        throw new Error(`инструмент ${name} ответил ошибкой: ${textOf(result)}`);
      }
      const text = textOf(result);
      return JSON.parse(text === '' ? 'null' : text) as T;
    },
    async callToolExpectingError(name: string, args: Record<string, unknown>): Promise<string> {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      return textOf(result);
    },
    async listToolNames(): Promise<string[]> {
      const listed = await client.listTools();
      return listed.tools.map((tool) => tool.name).sort();
    },
    async close(): Promise<void> {
      await client.close();
      await server.close();
      await ws.close();
      await mock.close();
    },
  };
}
