import { describe, expect, it } from 'vitest';
import { AuthError } from '../../src/auth/AuthProvider.js';
import {
  FAKE_CTS_PUBLIC_KEY_ID,
  FAKE_RTS_PUBLIC_KEY_ID,
  FAKE_SIGN_PUBLIC_KEY_ID,
  FakeAuthProvider,
  createFakeKeyMaterial,
} from '../../src/auth/FakeAuthProvider.js';

describe('фикстурный материал', () => {
  it('отдаёт оба вида ключей обмена, ключи подписи и параметры сокета', async () => {
    const auth = new FakeAuthProvider();

    const material = await auth.getKeyMaterial();

    expect(material.privateKeys.cts?.publicKeyId).toBe(FAKE_CTS_PUBLIC_KEY_ID);
    expect(material.privateKeys.rts?.publicKeyId).toBe(FAKE_RTS_PUBLIC_KEY_ID);
    expect(material.signKeys.publicId).toBe(FAKE_SIGN_PUBLIC_KEY_ID);
    expect(material.wsParams.instanceId).toBe('fake-instance-id');
  });

  it('тела детерминированы и имеют живые длины', () => {
    const first = createFakeKeyMaterial();
    const second = createFakeKeyMaterial();

    expect(first).toEqual(second);
    expect(Buffer.from(first.privateKeys.cts?.body ?? '', 'base64')).toHaveLength(32);
    expect(Buffer.from(first.signKeys.privateBody, 'base64')).toHaveLength(64);
  });

  it('каждый вызов даёт свой объект: правка в одном тесте не течёт в соседний', () => {
    expect(createFakeKeyMaterial()).not.toBe(createFakeKeyMaterial());
  });

  it('принимает подменённые значения', async () => {
    const auth = new FakeAuthProvider({ bearer: 'свой-токен', huid: 'свой-huid' });

    expect(await auth.getBearer()).toBe('свой-токен');
    expect(await auth.getWhoami()).toEqual({ huid: 'свой-huid' });
  });
});

describe('счётчики вызовов', () => {
  it('считает обращение к каждому методу порта', async () => {
    const auth = new FakeAuthProvider();

    await auth.getBearer();
    await auth.getBearer();
    await auth.getCookieHeader();
    await auth.getWhoami();
    await auth.getKeyMaterial();
    await auth.onAuthFailure();

    expect(auth.calls).toEqual({
      getBearer: 2,
      getCookieHeader: 1,
      getWhoami: 1,
      getKeyMaterial: 1,
      onAuthFailure: 1,
    });
  });
});

describe('отказ авторизации', () => {
  it('заряженный отказ срабатывает ровно один раз', async () => {
    const auth = new FakeAuthProvider();
    auth.failNextBearer();

    await expect(auth.getBearer()).rejects.toBeInstanceOf(AuthError);
    await expect(auth.getBearer()).resolves.toBe('fake-bearer');
    expect(auth.calls.getBearer).toBe(2);
  });

  it('пробрасывает заданный отказ как есть', async () => {
    const auth = new FakeAuthProvider();
    auth.failNextBearer(new AuthError('свой отказ', 'protocol'));

    await expect(auth.getBearer()).rejects.toMatchObject({ kind: 'protocol', message: 'свой отказ' });
  });

  it('onAuthFailure меняет токен: иначе повтор не отличить от вызова на старом токене', async () => {
    const auth = new FakeAuthProvider();
    const before = await auth.getBearer();

    await auth.onAuthFailure();

    expect(auth.bearer).not.toBe(before);
    expect(await auth.getBearer()).toBe('fake-bearer-1');
  });
});
