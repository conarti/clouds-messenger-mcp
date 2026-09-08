/**
 * Конфиг для тестов транспорта.
 *
 * Собирается из констант напрямую, а НЕ через loadConfig(): тот читает файл пользователя,
 * и тест на машине с настроенным конфигом получил бы чужие адреса и таймауты.
 */
import {
  DEFAULT_AUTH,
  DEFAULT_DOWNLOADS,
  DEFAULT_LIMITS,
  DEFAULT_PROTOCOL,
  DEFAULT_WS,
} from '../../src/config/defaults.js';
import type { Config, ConfigOverrides } from '../../src/config/types.js';

export function createTestConfig(overrides: ConfigOverrides = {}): Config {
  return {
    protocol: { ...DEFAULT_PROTOCOL, ...overrides.protocol },
    paths: {
      configFile: '/tmp/clouds-messenger-mcp-test/config.json',
      profileDir: '/tmp/clouds-messenger-mcp-test/profile',
      downloadsDir: '/tmp/clouds-messenger-mcp-test/downloads',
      ...overrides.paths,
    },
    downloads: { ...DEFAULT_DOWNLOADS, ...overrides.downloads },
    limits: { ...DEFAULT_LIMITS, ...overrides.limits },
    auth: { ...DEFAULT_AUTH, ...overrides.auth },
    ws: { ...DEFAULT_WS, ...overrides.ws },
  };
}
