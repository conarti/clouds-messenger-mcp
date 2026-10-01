/**
 * Ожидание установки браузера с бюджетом: инструмент не висит до конца загрузки, а отдаёт
 * размеченный статус с процентом. Иначе вызов оборвал бы таймаут клиента, и загрузка
 * выглядела бы сломанной авторизацией.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema, type Progress } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import type { InstallProgress, InstallWaitResult } from '../../src/auth/chromiumInstall.js';
import type { ToolDeps } from '../../src/mcp/tools/deps.js';
import { createServer } from '../../src/server.js';
import { createLogger } from '../../src/util/logger.js';
import { createTestConfig } from '../helpers/testConfig.js';

const INSTALL_WAIT_MS = 25;

function unusedDependency(what: string): () => never {
  return () => {
    throw new Error(`${what}: инструмент не должен идти к серверу, пока ставится браузер`);
  };
}

function createDeps(): { deps: ToolDeps; listChatRequests: ReturnType<typeof vi.fn> } {
  const config = createTestConfig({ auth: { browserInstallWaitMs: INSTALL_WAIT_MS } });
  const logger = createLogger({ level: 'error' });
  const listChatRequests = vi.fn(unusedDependency('ws.request'));
  const deps = {
    ws: { request: listChatRequests, close: vi.fn(async () => undefined) },
    rest: {
      getJson: vi.fn(unusedDependency('rest.getJson')),
      postJson: vi.fn(unusedDependency('rest.postJson')),
      getKdcKeys: vi.fn(unusedDependency('rest.getKdcKeys')),
    },
    auth: {
      getBearer: vi.fn(unusedDependency('auth.getBearer')),
      getCookieHeader: vi.fn(unusedDependency('auth.getCookieHeader')),
      getWhoami: vi.fn(unusedDependency('auth.getWhoami')),
      getKeyMaterial: vi.fn(unusedDependency('auth.getKeyMaterial')),
      onAuthFailure: vi.fn(unusedDependency('auth.onAuthFailure')),
    },
    crypto: {
      keys: {
        senderPublicKey: vi.fn(unusedDependency('crypto.keys.senderPublicKey')),
        resolveRecipientPublicKeys: vi.fn(unusedDependency('crypto.keys.resolveRecipientPublicKeys')),
      },
      decryptEvent: vi.fn(unusedDependency('crypto.decryptEvent')),
      encryptMessage: vi.fn(unusedDependency('crypto.encryptMessage')),
    },
    keyStore: {
      match: vi.fn(unusedDependency('keyStore.match')),
      require: vi.fn(unusedDependency('keyStore.require')),
    },
    config,
    logger,
  } satisfies ToolDeps;
  return { deps, listChatRequests };
}

/** Установка, которая шлёт прогресс подписчикам и отдаёт заданный исход ожидания */
function fakeInstall(
  outcome: InstallWaitResult,
  progress: InstallProgress | undefined,
  failure: Error | undefined = undefined,
) {
  const listeners = new Set<(progress: InstallProgress) => void>();
  return {
    currentProgress: progress,
    failure,
    waitFor: vi.fn(async (_budgetMs: number) => {
      if (progress !== undefined) {
        for (const listener of listeners) {
          listener(progress);
        }
      }
      return outcome;
    }),
    onProgress(listener: (progress: InstallProgress) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

async function connect(browserInstall: ReturnType<typeof fakeInstall>) {
  const { deps, listChatRequests } = createDeps();
  const server = createServer({ config: deps.config, logger: deps.logger, deps, browserInstall });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'clouds-messenger-mcp-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    listChatRequests,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

function textOf(result: unknown): string {
  return (result as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? '';
}

describe('инструмент во время установки браузера', () => {
  it('не уложились в бюджет: статус browser_install_in_progress с процентом, а не ошибка', async () => {
    const install = fakeInstall('pending', { percent: 40, total: '150.2 MiB' });
    const harness = await connect(install);
    try {
      const result = await harness.client.callTool({ name: 'list_chats', arguments: {} });

      expect(result.isError).not.toBe(true);
      expect(JSON.parse(textOf(result))).toEqual({
        status: 'browser_install_in_progress',
        percent: 40,
        total: '150.2 MiB',
        next_step: expect.stringContaining('повторите вызов'),
      });
      expect(install.waitFor).toHaveBeenCalledWith(INSTALL_WAIT_MS);
      expect(harness.listChatRequests).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  it('с токеном прогресса шлёт уведомление о загрузке', async () => {
    const install = fakeInstall('pending', { percent: 40, total: '150.2 MiB' });
    const harness = await connect(install);
    const received: Progress[] = [];
    try {
      await harness.client.callTool({ name: 'get_history', arguments: { chat: 'Избранное' } }, CallToolResultSchema, {
        onprogress: (progress) => received.push(progress),
      });

      expect(received).toEqual([
        expect.objectContaining({ progress: 40, total: 100, message: expect.stringContaining('150.2 MiB') }),
      ]);
    } finally {
      await harness.close();
    }
  });

  it('установка не удалась: отказ авторизации с командой ручной установки, сервер не трогается', async () => {
    const failure = new Error('Chromium не установлен: ENOTFOUND. Установите браузер вручную: npx playwright@1.63.0 install chromium');
    const harness = await connect(fakeInstall('failed', undefined, failure));
    try {
      const result = await harness.client.callTool({ name: 'search', arguments: { query: 'дейли' } });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('auth_protocol');
      expect(textOf(result)).toContain('npx playwright@1.63.0 install chromium');
      expect(harness.listChatRequests).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  it('браузер готов: инструмент идёт дальше обычным путём', async () => {
    const harness = await connect(fakeInstall('ready', undefined));
    try {
      await harness.client.callTool({ name: 'list_chats', arguments: {} });

      expect(harness.listChatRequests).toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });
});
