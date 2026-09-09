import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  AuthConfig,
  DownloadsConfig,
  LimitsConfig,
  PathsConfig,
  ProtocolConfig,
  WsConfig,
} from './types.js';

/** Каталог артефактов внутри ~/.config */
const CONFIG_DIR_NAME = 'clouds-messenger-mcp';
const CONFIG_FILE_NAME = 'config.json';
const PROFILE_DIR_NAME = 'profile';
const DOWNLOADS_DIR_NAME = 'downloads';

/** Переменная окружения, переопределяющая путь файла конфига (нужна тестам) */
export const CONFIG_FILE_ENV = 'CLOUDS_MESSENGER_MCP_CONFIG';

/**
 * Значения сняты живой пробой Фазы 0 (findings.md).
 *
 * `wsVersion` и `chatListRequestVersion` совпадают числом по совпадению, а не по смыслу:
 * первое это версия сокета в query, второе это версия схемы события списка чатов.
 * Разводить их в разные поля обязательно, иначе одна ротация утащит за собой вторую.
 */
export const DEFAULT_PROTOCOL: ProtocolConfig = {
  webOrigin: 'https://clouds.org.ru',
  restBaseUrl: 'https://cts01.clouds.org.ru/api',
  wsUrl: 'wss://cts01.clouds.org.ru/socket/user/websocket',
  wsVsn: '1.0.0',
  wsVersion: 6,
  chatListRequestVersion: 6,
  threadListRequestVersion: 2,
  kdcKeysPath: '/v1/kdc/keys/',
  /* Форма снята живой пробой: POST с телом {huids:[...]}, ответ группами по серверам */
  phonebookProfilesPath: '/v1/phonebook/cts_profiles/query',
  /*
   * Форма из бандла веб-клиента: GET <base>/v2/file_service/files/groupchat_file/<chat>/<file>
   * с query key_id. Живой пробой не подтверждена (findings.md, P2: вложение наблюдалось,
   * скачивание нет).
   */
  fileServicePath: '/v2/file_service/files/groupchat_file/',
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
};

export const DEFAULT_DOWNLOADS: DownloadsConfig = {
  ttlDays: 7,
  /* 256 МиБ: заметно больше любого наблюдённого вложения и заметно меньше свободного места */
  maxFileSizeBytes: 256 * 1024 * 1024,
};

export const DEFAULT_LIMITS: LimitsConfig = {
  listChatsDefaultLimit: 50,
  searchDefaultLimit: 50,
  historyDefaultLimit: 50,
  /* 10 минут: заметно дольше серии вызовов подряд и заметно короче рабочего дня */
  profileCacheTtlMs: 600_000,
};

export const DEFAULT_AUTH: AuthConfig = {
  headlessTimeoutMs: 30_000,
  headedTimeoutMs: 300_000,
};

export const DEFAULT_WS: WsConfig = {
  authenticateTimeoutMs: 10_000,
  authenticateAttempts: 2,
  requestTimeoutMs: 30_000,
  reconnectAttempts: 5,
  reconnectBaseDelayMs: 500,
  reconnectMaxDelayMs: 10_000,
  heartbeatIntervalMs: 30_000,
  /* 5 минут: заметно дольше любой серии запросов подряд и заметно короче рабочего перерыва */
  idleCloseMs: 300_000,
};

/**
 * Пути по умолчанию считаются функцией, а не константой: `homedir()` на модульном уровне
 * замерзает на первом импорте, и тест, подменивший домашний каталог, получил бы чужие пути.
 */
export function defaultPaths(): PathsConfig {
  const configDir = join(homedir(), '.config', CONFIG_DIR_NAME);
  return {
    configFile: join(configDir, CONFIG_FILE_NAME),
    profileDir: join(configDir, PROFILE_DIR_NAME),
    downloadsDir: join(configDir, DOWNLOADS_DIR_NAME),
  };
}
