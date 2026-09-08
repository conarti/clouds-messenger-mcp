import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthProvider } from '../../src/auth/AuthProvider.js';
import type { KeyStore } from '../../src/auth/keyStore.js';
import { CONFIG_FILE_ENV } from '../../src/config/defaults.js';
import { loadConfig } from '../../src/config/loadConfig.js';
import type { CryptoService } from '../../src/crypto/types.js';
import type { ToolDeps } from '../../src/mcp/tools/deps.js';
import { SERVER_NAME, SERVER_VERSION, TOOL_NAMES, createServer } from '../../src/server.js';
import type { RestClient } from '../../src/transport/types.js';
import type { PhoenixClient } from '../../src/transport/ws/types.js';
import { createLogger, type Logger } from '../../src/util/logger.js';

/**
 * Любое обращение к зависимости на пути сборки и `tools/list` это нарушение контракта
 * «список инструментов отвечает без сессии», поэтому заглушка не возвращает пустоту,
 * а падает: тихий вызов иначе прошёл бы незамеченным.
 */
function forbidden(what: string): () => never {
  return () => {
    throw new Error(`${what}: обращение к зависимостям при сборке сервера запрещено`);
  };
}

function createHarness() {
  const ws = {
    request: vi.fn(forbidden('ws.request')),
    close: vi.fn(forbidden('ws.close')),
  } satisfies PhoenixClient;

  const rest = {
    getJson: vi.fn(forbidden('rest.getJson')),
    getKdcKeys: vi.fn(forbidden('rest.getKdcKeys')),
  } satisfies RestClient;

  const auth = {
    getBearer: vi.fn(forbidden('auth.getBearer')),
    getCookieHeader: vi.fn(forbidden('auth.getCookieHeader')),
    getWhoami: vi.fn(forbidden('auth.getWhoami')),
    getKeyMaterial: vi.fn(forbidden('auth.getKeyMaterial')),
    onAuthFailure: vi.fn(forbidden('auth.onAuthFailure')),
  } satisfies AuthProvider;

  const cryptoService = {
    keys: {
      senderPublicKey: vi.fn(forbidden('crypto.keys.senderPublicKey')),
      resolveRecipientPublicKeys: vi.fn(forbidden('crypto.keys.resolveRecipientPublicKeys')),
    },
    decryptEvent: vi.fn(forbidden('crypto.decryptEvent')),
    encryptMessage: vi.fn(forbidden('crypto.encryptMessage')),
  } satisfies CryptoService;

  const keyStore = {
    match: vi.fn(forbidden('keyStore.match')),
    require: vi.fn(forbidden('keyStore.require')),
  } satisfies KeyStore;

  const logger = {
    debug: vi.fn(forbidden('logger.debug')),
    info: vi.fn(forbidden('logger.info')),
    warn: vi.fn(forbidden('logger.warn')),
    error: vi.fn(forbidden('logger.error')),
    child: vi.fn(forbidden('logger.child')),
  } satisfies Logger;

  const config = loadConfig();
  const deps: ToolDeps = { ws, rest, auth, crypto: cryptoService, keyStore, config, logger };

  const mocks = [
    ws.request,
    ws.close,
    rest.getJson,
    rest.getKdcKeys,
    auth.getBearer,
    auth.getCookieHeader,
    auth.getWhoami,
    auth.getKeyMaterial,
    auth.onAuthFailure,
    cryptoService.keys.senderPublicKey,
    cryptoService.keys.resolveRecipientPublicKeys,
    cryptoService.decryptEvent,
    cryptoService.encryptMessage,
    keyStore.match,
    keyStore.require,
    logger.debug,
    logger.info,
    logger.warn,
    logger.error,
    logger.child,
  ];

  return { config, deps, logger, mocks };
}

beforeEach(() => {
  /* Файл конфига в тесте заведомо отсутствует: сборка сервера не зависит от машины */
  process.env[CONFIG_FILE_ENV] = join(tmpdir(), 'clouds-messenger-mcp-нет-такого-файла.json');
});

afterEach(() => {
  delete process.env[CONFIG_FILE_ENV];
});

describe('контракт инструментов', () => {
  it('объявляет десять непустых уникальных имён', () => {
    expect(TOOL_NAMES).toHaveLength(10);
    expect(new Set(TOOL_NAMES).size).toBe(10);
    expect(SERVER_NAME).toBe('clouds-messenger-mcp');
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('tools/list без сессии', () => {
  it('отвечает по MCP и не трогает ни одной зависимости', async () => {
    const { config, deps, mocks } = createHarness();
    const server = createServer({
      config,
      /* Логгер сборки отдельный: логирование это не обращение к зависимостям инструментов */
      logger: createLogger({ level: 'error' }),
      deps,
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'clouds-messenger-mcp-test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const listed = await client.listTools();

      for (const tool of listed.tools) {
        expect(TOOL_NAMES).toContain(tool.name);
      }
      for (const mock of mocks) {
        expect(mock).not.toHaveBeenCalled();
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
