import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONFIG_FILE_ENV,
  DEFAULT_AUTH,
  DEFAULT_DOWNLOADS,
  DEFAULT_LIMITS,
  DEFAULT_PROTOCOL,
  DEFAULT_WS,
} from '../../src/config/defaults.js';
import { loadConfig, resolveConfigFile } from '../../src/config/loadConfig.js';

let workDir: string;
let configFile: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'cmm-config-'));
  configFile = join(workDir, 'config.json');
  process.env[CONFIG_FILE_ENV] = configFile;
});

afterEach(() => {
  delete process.env[CONFIG_FILE_ENV];
  rmSync(workDir, { recursive: true, force: true });
});

describe('loadConfig без файла', () => {
  it('не бросает и отдаёт дефолты всех секций', () => {
    const config = loadConfig();

    expect(config.protocol).toEqual(DEFAULT_PROTOCOL);
    expect(config.downloads).toEqual(DEFAULT_DOWNLOADS);
    expect(config.limits).toEqual(DEFAULT_LIMITS);
    expect(config.auth).toEqual(DEFAULT_AUTH);
    expect(config.ws).toEqual(DEFAULT_WS);
  });

  it('кладёт профиль и загрузки в ~/.config/clouds-messenger-mcp', () => {
    const expectedDir = join(homedir(), '.config', 'clouds-messenger-mcp');
    const config = loadConfig();

    expect(config.paths.profileDir).toBe(join(expectedDir, 'profile'));
    expect(config.paths.downloadsDir).toBe(join(expectedDir, 'downloads'));
  });

  it('несёт протокольные константы Клаудс', () => {
    const config = loadConfig();

    expect(config.protocol.webOrigin).toBe('https://clouds.org.ru');
    expect(config.protocol.restBaseUrl).toBe('https://cts01.clouds.org.ru/api');
    expect(config.protocol.wsUrl).toBe('wss://cts01.clouds.org.ru/socket/user/websocket');
    expect(config.protocol.kdcKeysPath).toBe('/v1/kdc/keys/');
  });
});

describe('resolveConfigFile', () => {
  it('берёт путь файла из переменной окружения', () => {
    expect(resolveConfigFile()).toBe(configFile);
    expect(loadConfig().paths.configFile).toBe(configFile);
  });

  it('без переменной окружения указывает в домашний каталог', () => {
    delete process.env[CONFIG_FILE_ENV];

    expect(resolveConfigFile()).toBe(
      join(homedir(), '.config', 'clouds-messenger-mcp', 'config.json'),
    );
  });
});

describe('приоритет источников', () => {
  /*
   * AC-22: три источника участвуют одновременно, и каждый виден в результате.
   * Проверка по одному источнику за раз этого не доказывает: она проходит и на реализации,
   * которая теряет файл, когда есть аргумент.
   */
  it('дефолты < файл < аргумент, слияние поточечное внутри секции', () => {
    writeFileSync(
      configFile,
      JSON.stringify({
        limits: { listChatsDefaultLimit: 11, searchDefaultLimit: 22 },
        ws: { requestTimeoutMs: 1234 },
        paths: { profileDir: join(workDir, 'profile-from-file') },
      }),
    );

    const config = loadConfig({
      limits: { listChatsDefaultLimit: 99 },
      paths: { profileDir: join(workDir, 'profile-from-argument') },
    });

    /* Аргумент бьёт файл */
    expect(config.limits.listChatsDefaultLimit).toBe(99);
    /* Файл бьёт дефолт */
    expect(config.limits.searchDefaultLimit).toBe(22);
    expect(config.ws.requestTimeoutMs).toBe(1234);
    /* Дефолт выживает там, где его никто не трогал */
    expect(config.limits.historyDefaultLimit).toBe(DEFAULT_LIMITS.historyDefaultLimit);
    expect(config.ws.reconnectAttempts).toBe(DEFAULT_WS.reconnectAttempts);
    expect(config.protocol).toEqual(DEFAULT_PROTOCOL);
  });

  /*
   * Закрытие сокета по простою включено по умолчанию: оно про присутствие человека в сети,
   * а значение, которое надо включать руками, до пользователя не доедет.
   */
  it('простой закрывает сокет через пять минут, и ноль это выключает', () => {
    expect(DEFAULT_WS.idleCloseMs).toBe(300_000);

    writeFileSync(configFile, JSON.stringify({ ws: { idleCloseMs: 0 } }));

    expect(loadConfig().ws.idleCloseMs).toBe(0);
  });

  it('profileDir переопределяется файлом', () => {
    const fromFile = join(workDir, 'profile-from-file');
    writeFileSync(configFile, JSON.stringify({ paths: { profileDir: fromFile } }));

    expect(loadConfig().paths.profileDir).toBe(fromFile);
  });

  it('profileDir переопределяется аргументом поверх файла', () => {
    const fromFile = join(workDir, 'profile-from-file');
    const fromArgument = join(workDir, 'profile-from-argument');
    writeFileSync(configFile, JSON.stringify({ paths: { profileDir: fromFile } }));

    expect(loadConfig({ paths: { profileDir: fromArgument } }).paths.profileDir).toBe(fromArgument);
  });

  it('configFile отчитывается о фактически прочитанном файле', () => {
    writeFileSync(configFile, JSON.stringify({ paths: { configFile: '/подделка/config.json' } }));

    expect(loadConfig().paths.configFile).toBe(configFile);
  });
});

describe('битый файл', () => {
  it('бросает понятную ошибку на невалидном JSON', () => {
    writeFileSync(configFile, '{ not json');

    expect(() => loadConfig()).toThrow(/невалидный JSON/);
  });

  it('бросает, когда в файле не объект', () => {
    writeFileSync(configFile, '[1, 2, 3]');

    expect(() => loadConfig()).toThrow(/JSON-объектом/);
  });
});
