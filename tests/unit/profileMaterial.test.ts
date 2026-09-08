import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildCookieHeader,
  extractHuidFromProfiles,
  extractKeyMaterialFromAuthState,
  parseWsParams,
  type ProfileCookie,
} from '../../src/auth/profileMaterial.js';

/**
 * Тела ключей генерируются на месте: живое значение здесь ничего не доказало бы, зато
 * осталось бы в исходниках, в истории и в любом форке.
 */
function syntheticBody(length: number): string {
  return randomBytes(length).toString('base64');
}

const CTS_BODY = syntheticBody(32);
const RTS_BODY = syntheticBody(32);
const SIGN_BODY = syntheticBody(64);

/**
 * Форма записи `authState`/items с оракула p235-reads.mjs: узел лежит под произвольной
 * обёрткой, а `privateKeys` соседствует с `publicKeys` и `signKeys`.
 */
function authStateRow(overrides: { withRts?: boolean; withSignKeys?: boolean } = {}): unknown {
  const { withRts = true, withSignKeys = true } = overrides;
  return {
    persist: {
      version: 1,
      user: {
        privateKeys: {
          cts: { body: CTS_BODY, publicKeyId: 'cts-public-key-id', keyType: 'x25519' },
          ...(withRts ? { rts: { body: RTS_BODY, publicKeyId: 'rts-public-key-id' } } : {}),
        },
        publicKeys: {
          cts: { body: syntheticBody(32), id: 'cts-public-key-id' },
        },
        ...(withSignKeys
          ? {
              signKeys: {
                private: { body: SIGN_BODY },
                public: { id: 'sign-public-key-id' },
                keyType: 'ed25519',
              },
            }
          : {}),
      },
    },
  };
}

describe('extractKeyMaterialFromAuthState', () => {
  it('достаёт cts, rts и ключи подписи из вложенной записи', () => {
    const material = extractKeyMaterialFromAuthState([{ unrelated: true }, authStateRow()]);

    expect(material).toEqual({
      privateKeys: {
        cts: { body: CTS_BODY, publicKeyId: 'cts-public-key-id' },
        rts: { body: RTS_BODY, publicKeyId: 'rts-public-key-id' },
      },
      signKeys: { privateBody: SIGN_BODY, publicId: 'sign-public-key-id' },
    });
  });

  it('отсутствие вида ключа это штатное состояние, а не отказ', () => {
    const material = extractKeyMaterialFromAuthState([authStateRow({ withRts: false })]);

    expect(material?.privateKeys.cts).toBeDefined();
    expect(material?.privateKeys.rts).toBeUndefined();
  });

  it('без ключей подписи материал непригоден: отправка ими подписывается', () => {
    expect(extractKeyMaterialFromAuthState([authStateRow({ withSignKeys: false })])).toBeUndefined();
  });

  it('на записях без ключей отдаёт пустоту, а не падает', () => {
    expect(extractKeyMaterialFromAuthState([])).toBeUndefined();
    expect(extractKeyMaterialFromAuthState([null, 42, 'строка', { settings: {} }])).toBeUndefined();
  });
});

describe('extractHuidFromProfiles', () => {
  it('берёт huid записи с признаком isMe', () => {
    const profiles = {
      entities: [
        { isMe: false, userHuid: 'чужой-huid' },
        { isMe: true, userHuid: 'мой-huid' },
      ],
    };

    expect(extractHuidFromProfiles(profiles)).toBe('мой-huid');
  });

  it('без записи isMe отдаёт пустоту', () => {
    expect(extractHuidFromProfiles({ entities: [{ isMe: false, userHuid: 'чужой-huid' }] })).toBeUndefined();
    expect(extractHuidFromProfiles(null)).toBeUndefined();
  });
});

describe('parseWsParams', () => {
  it('разбирает key_id и instance_id из query сокета', () => {
    const url =
      'wss://cts01.clouds.org.ru/socket/user/websocket?key_id=aaaa1111&instance_id=7f0c1d2e&version=6&vsn=1.0.0';

    expect(parseWsParams(url)).toEqual({ keyId: 'aaaa1111', instanceId: '7f0c1d2e' });
  });

  it('без обоих параметров отдаёт пустоту: подставлять их нельзя', () => {
    expect(parseWsParams('wss://cts01.clouds.org.ru/socket/user/websocket?vsn=1.0.0')).toBeUndefined();
    expect(parseWsParams('wss://cts01.clouds.org.ru/socket?key_id=aaaa1111')).toBeUndefined();
    expect(parseWsParams('не url')).toBeUndefined();
  });
});

describe('buildCookieHeader', () => {
  const cookies: ProfileCookie[] = [
    { name: 'ctsAuthToken', value: 'cts-token', domain: '.clouds.org.ru' },
    { name: 'authToken', value: 'global-token', domain: 'cts01.clouds.org.ru' },
    { name: 'sessionid', value: 'чужой', domain: '.example.com' },
  ];

  it('собирает только cookie хостов сессии', () => {
    const header = buildCookieHeader(cookies, ['clouds.org.ru', 'cts01.clouds.org.ru']);

    expect(header).toBe('ctsAuthToken=cts-token; authToken=global-token');
  });

  it('не выпускает наружу cookie посторонних доменов', () => {
    expect(buildCookieHeader(cookies, ['clouds.org.ru'])).not.toContain('sessionid');
  });

  it('схлопывает повтор имени: одно имя приезжает и от хоста, и от родительского домена', () => {
    const duplicated: ProfileCookie[] = [
      { name: 'ctsAuthToken', value: 'от-хоста', domain: 'cts01.clouds.org.ru' },
      { name: 'ctsAuthToken', value: 'от-домена', domain: '.clouds.org.ru' },
    ];

    expect(buildCookieHeader(duplicated, ['cts01.clouds.org.ru'])).toBe('ctsAuthToken=от-хоста');
  });

  it('на пустом наборе отдаёт пустую строку', () => {
    expect(buildCookieHeader([], ['clouds.org.ru'])).toBe('');
  });
});
