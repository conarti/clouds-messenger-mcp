/**
 * Покрытие регистрации (класс C).
 *
 * ЧТО ОХРАНЯЕТСЯ. Инструменты разложены на две категории: читающие и подтверждаемые.
 * Категория это не украшение, а обещание вызывающему: подтверждаемый инструмент
 * необратим и требует двух шагов. Забытая классификация нового инструмента означала бы,
 * что необратимая операция молча уехала в набор как обычная, и заметить это можно было бы
 * только по последствиям.
 *
 * Три множества сверяются РАЗОМ: объединение категорий, канонический список и то, что
 * сервер действительно выставил по MCP. Сверка любых двух из трёх оставляла бы дыру:
 * список и категории могли бы согласованно разойтись с регистрацией.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import type { AuthProvider } from '../../src/auth/AuthProvider.js';
import type { KeyStore } from '../../src/auth/keyStore.js';
import type { CryptoService } from '../../src/crypto/types.js';
import type { ToolDeps } from '../../src/mcp/tools/deps.js';
import { CONFIRM_TOOLS, READ_TOOLS, TOOL_NAMES, createServer } from '../../src/server.js';
import type { RestClient } from '../../src/transport/types.js';
import type { PhoenixClient } from '../../src/transport/ws/types.js';
import { createLogger } from '../../src/util/logger.js';
import { createTestConfig } from '../helpers/testConfig.js';

/** Сборка сервера и tools/list обязаны обходиться без сессии: тихий вызов должен падать */
function forbidden(what: string): () => never {
  return () => {
    throw new Error(`${what}: обращение к зависимостям при сборке сервера запрещено`);
  };
}

function createDeps(): ToolDeps {
  const ws: PhoenixClient = {
    request: vi.fn(forbidden('ws.request')),
    close: vi.fn(forbidden('ws.close')),
  };
  const rest: RestClient = {
    getJson: vi.fn(forbidden('rest.getJson')),
    postJson: vi.fn(forbidden('rest.postJson')),
    getKdcKeys: vi.fn(forbidden('rest.getKdcKeys')),
  };
  const auth: AuthProvider = {
    getBearer: vi.fn(forbidden('auth.getBearer')),
    getCookieHeader: vi.fn(forbidden('auth.getCookieHeader')),
    getWhoami: vi.fn(forbidden('auth.getWhoami')),
    getKeyMaterial: vi.fn(forbidden('auth.getKeyMaterial')),
    onAuthFailure: vi.fn(forbidden('auth.onAuthFailure')),
  };
  const crypto: CryptoService = {
    keys: {
      senderPublicKey: vi.fn(forbidden('crypto.keys.senderPublicKey')),
      resolveRecipientPublicKeys: vi.fn(forbidden('crypto.keys.resolveRecipientPublicKeys')),
    },
    decryptEvent: vi.fn(forbidden('crypto.decryptEvent')),
    encryptMessage: vi.fn(forbidden('crypto.encryptMessage')),
  };
  const keyStore: KeyStore = {
    match: vi.fn(forbidden('keyStore.match')),
    require: vi.fn(forbidden('keyStore.require')),
  };
  const logger = createLogger({ level: 'error' });
  const config = createTestConfig();

  return { ws, rest, auth, crypto, keyStore, config, logger };
}

/** Имена, которые сервер реально выставил наружу */
async function listRegisteredNames(): Promise<string[]> {
  const deps = createDeps();
  const server = createServer({ config: deps.config, logger: deps.logger, deps });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'clouds-messenger-mcp-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const listed = await client.listTools();
    return listed.tools.map((tool) => tool.name).sort();
  } finally {
    await client.close();
    await server.close();
  }
}

const READ_SET = new Set<string>(READ_TOOLS);
const CONFIRM_SET = new Set<string>(CONFIRM_TOOLS);

describe('категории инструментов', () => {
  it('не пересекаются и внутри себя не повторяются', () => {
    expect(READ_SET.size).toBe(READ_TOOLS.length);
    expect(CONFIRM_SET.size).toBe(CONFIRM_TOOLS.length);
    expect([...READ_SET].filter((name) => CONFIRM_SET.has(name))).toEqual([]);
  });

  it('в объединении дают канонический список целиком', () => {
    const union = [...READ_TOOLS, ...CONFIRM_TOOLS].sort();

    expect(union).toEqual([...TOOL_NAMES].sort());
    expect(union).toHaveLength(10);
  });

  it('подтверждение требуется ровно необратимой отправке', () => {
    expect([...CONFIRM_TOOLS]).toEqual(['send_message']);
  });
});

describe('регистрация покрыта категориями', () => {
  it('живой tools/list отдаёт ровно те имена, что разложены по категориям', async () => {
    const registered = await listRegisteredNames();

    expect(registered).toEqual([...READ_TOOLS, ...CONFIRM_TOOLS].sort());
    expect(registered).toEqual([...TOOL_NAMES].sort());
    expect(registered).toHaveLength(10);
  });
});
