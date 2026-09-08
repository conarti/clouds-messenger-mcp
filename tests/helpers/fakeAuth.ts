/**
 * Минимальный AuthProvider для тестов транспорта.
 *
 * Живёт в тестовых хелперах, а не в src: транспорту нужен предсказуемый источник bearer
 * и cookie со счётчиками вызовов, и подмешивать такую вещь в поставляемый код незачем.
 *
 * `onAuthFailure()` меняет bearer: только так проверяется, что повтор после отказа идёт
 * с НОВЫМ токеном, а не с тем же самым.
 */
import type { AuthProvider, KeyMaterial, Whoami } from '../../src/auth/AuthProvider.js';

export class FakeAuth implements AuthProvider {
  bearer = 'bearer-1';
  cookieHeader = 'clouds_session=fake-session';
  keyId = '11111111-1111-5111-8111-111111111111';
  instanceId = '22222222-2222-5222-8222-222222222222';

  readonly calls = {
    getBearer: 0,
    getCookieHeader: 0,
    getWhoami: 0,
    getKeyMaterial: 0,
    onAuthFailure: 0,
  };

  private bearerCounter = 1;

  async getBearer(): Promise<string> {
    this.calls.getBearer += 1;
    return this.bearer;
  }

  async getCookieHeader(): Promise<string> {
    this.calls.getCookieHeader += 1;
    return this.cookieHeader;
  }

  async getWhoami(): Promise<Whoami> {
    this.calls.getWhoami += 1;
    return { huid: '33333333-3333-5333-8333-333333333333' };
  }

  async getKeyMaterial(): Promise<KeyMaterial> {
    this.calls.getKeyMaterial += 1;
    return {
      privateKeys: {
        cts: { body: 'Y3RzLXByaXZhdGUta2V5', publicKeyId: '44444444-4444-5444-8444-444444444444' },
      },
      signKeys: {
        privateBody: 'c2lnbi1wcml2YXRlLWtleQ==',
        publicId: '55555555-5555-5555-8555-555555555555',
      },
      wsParams: { keyId: this.keyId, instanceId: this.instanceId },
    };
  }

  async onAuthFailure(): Promise<void> {
    this.calls.onAuthFailure += 1;
    this.bearerCounter += 1;
    this.bearer = `bearer-${this.bearerCounter}`;
  }
}
