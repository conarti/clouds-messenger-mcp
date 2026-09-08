import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PlaywrightProfileAuth } from '../../src/auth/PlaywrightProfileAuth.js';
import type { ProfileSession, ProfileSessionSource } from '../../src/auth/ProfileSessionSource.js';
import { CONFIG_FILE_ENV } from '../../src/config/defaults.js';
import { loadConfig } from '../../src/config/loadConfig.js';
import { createLogger } from '../../src/util/logger.js';

/**
 * Подложный источник вместо браузера: считает подъёмы и отдаёт каждый раз НОВЫЙ снимок.
 * Различие снимков обязательно, иначе тест не отличил бы отданный кэш от свежего подъёма.
 */
class FakeProfileSource implements ProfileSessionSource {
  loadCalls = 0;
  refreshCalls = 0;

  private snapshots = 0;
  /** Ворота: пока держим, подъём висит. Так тест ловит состояние «подъём в полёте» */
  private gate: Promise<void> | undefined;
  private openGate: (() => void) | undefined;

  hold(): void {
    this.gate = new Promise((resolve) => {
      this.openGate = resolve;
    });
  }

  release(): void {
    this.openGate?.();
    this.gate = undefined;
    this.openGate = undefined;
  }

  async load(): Promise<ProfileSession> {
    this.loadCalls += 1;
    return this.snapshot();
  }

  async refresh(): Promise<ProfileSession> {
    this.refreshCalls += 1;
    return this.snapshot();
  }

  private async snapshot(): Promise<ProfileSession> {
    if (this.gate !== undefined) {
      await this.gate;
    }
    this.snapshots += 1;
    const mark = String(this.snapshots);
    return {
      bearer: `bearer-${mark}`,
      cookieHeader: `ctsAuthToken=cookie-${mark}`,
      huid: `huid-${mark}`,
      keyMaterial: {
        privateKeys: { cts: { body: 'AAAA', publicKeyId: `cts-${mark}` } },
        signKeys: { privateBody: 'BBBB', publicId: `sign-${mark}` },
        wsParams: { keyId: `cts-${mark}`, instanceId: `instance-${mark}` },
      },
    };
  }
}

function provider(source: ProfileSessionSource): PlaywrightProfileAuth {
  return new PlaywrightProfileAuth({
    config: loadConfig(),
    /* Уровень error глушит штатные warn обновления: тесту нужен результат, а не шум в stderr */
    logger: createLogger({ level: 'error' }),
    source,
  });
}

beforeEach(() => {
  /* Файл конфига в тесте заведомо отсутствует: результат не зависит от машины */
  process.env[CONFIG_FILE_ENV] = join(tmpdir(), 'clouds-messenger-mcp-нет-такого-файла.json');
});

afterEach(() => {
  delete process.env[CONFIG_FILE_ENV];
});

describe('снимок профиля и кэш', () => {
  it('раскладывает снимок по методам порта', async () => {
    const auth = provider(new FakeProfileSource());

    expect(await auth.getBearer()).toBe('bearer-1');
    expect(await auth.getCookieHeader()).toBe('ctsAuthToken=cookie-1');
    expect(await auth.getWhoami()).toEqual({ huid: 'huid-1' });
    expect((await auth.getKeyMaterial()).wsParams).toEqual({ keyId: 'cts-1', instanceId: 'instance-1' });
  });

  it('кэширует снимок: повторные вызовы профиль не поднимают', async () => {
    const source = new FakeProfileSource();
    const auth = provider(source);

    await auth.getBearer();
    await auth.getCookieHeader();
    await auth.getWhoami();
    await auth.getKeyMaterial();

    expect(source.loadCalls).toBe(1);
  });
});

describe('схлопывание входов', () => {
  it('параллельные вызовы на холодном кэше дают ровно один подъём профиля', async () => {
    const source = new FakeProfileSource();
    const auth = provider(source);

    const [bearer, cookieHeader, whoami, material] = await Promise.all([
      auth.getBearer(),
      auth.getCookieHeader(),
      auth.getWhoami(),
      auth.getKeyMaterial(),
    ]);

    expect(source.loadCalls).toBe(1);
    expect(source.refreshCalls).toBe(0);
    /* Все ждущие получили ОДИН и тот же снимок, а не четыре разных */
    expect(bearer).toBe('bearer-1');
    expect(cookieHeader).toBe('ctsAuthToken=cookie-1');
    expect(whoami).toEqual({ huid: 'huid-1' });
    expect(material.signKeys.publicId).toBe('sign-1');
  });
});

describe('обновление сессии', () => {
  it('getBearer(true) сбрасывает кэш и обновляет сессию', async () => {
    const source = new FakeProfileSource();
    const auth = provider(source);

    expect(await auth.getBearer()).toBe('bearer-1');
    expect(await auth.getBearer(true)).toBe('bearer-2');
    expect(await auth.getCookieHeader()).toBe('ctsAuthToken=cookie-2');
    expect(source.loadCalls).toBe(1);
    expect(source.refreshCalls).toBe(1);
  });

  it('серия параллельных обновлений даёт один подъём, и новые значения видят все ждущие', async () => {
    const source = new FakeProfileSource();
    const auth = provider(source);
    const before = await auth.getBearer();

    const [firstBearer, secondBearer, cookieHeader] = await Promise.all([
      auth.getBearer(true),
      auth.getBearer(true),
      auth.getCookieHeader(),
    ]);

    expect(source.refreshCalls).toBe(1);
    expect(firstBearer).toBe(secondBearer);
    expect(firstBearer).not.toBe(before);
    expect(cookieHeader).toBe('ctsAuthToken=cookie-2');
  });

  it('onAuthFailure сбрасывает кэш и обновляет ровно один раз на серию', async () => {
    const source = new FakeProfileSource();
    const auth = provider(source);
    await auth.getBearer();

    await Promise.all([auth.onAuthFailure(), auth.onAuthFailure(), auth.onAuthFailure()]);

    expect(source.refreshCalls).toBe(1);
    expect(await auth.getBearer()).toBe('bearer-2');
    /* Новый снимок лёг в кэш: второго подъёма после обновления не случилось */
    expect(source.loadCalls).toBe(1);
  });

  it('пока идёт обновление, обычные вызовы примыкают к нему, а не поднимают профиль заново', async () => {
    const source = new FakeProfileSource();
    const auth = provider(source);
    source.hold();

    const refreshing = auth.getBearer(true);
    const joined = auth.getKeyMaterial();
    source.release();

    const [bearer, material] = await Promise.all([refreshing, joined]);

    expect(source.loadCalls).toBe(0);
    expect(source.refreshCalls).toBe(1);
    expect(bearer).toBe('bearer-1');
    expect(material.wsParams.instanceId).toBe('instance-1');
  });
});
