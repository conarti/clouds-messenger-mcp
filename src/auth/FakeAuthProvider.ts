/**
 * Подложный провайдер авторизации: валидный материал без браузера и без сети.
 *
 * Нужен тестам транспорта и крипто, чтобы не тащить Playwright и живую учётную запись.
 * Тела ключей синтетические и детерминированные: случайные значения делали бы падение
 * теста невоспроизводимым, а живые нельзя держать в репозитории ни в каком виде.
 */
import {
  AuthError,
  type AuthProvider,
  type KeyMaterial,
  type Whoami,
} from './AuthProvider.js';

export const FAKE_CTS_PUBLIC_KEY_ID = 'fake-cts-public-key-id';
export const FAKE_RTS_PUBLIC_KEY_ID = 'fake-rts-public-key-id';
export const FAKE_SIGN_PUBLIC_KEY_ID = 'fake-sign-public-key-id';
export const FAKE_BEARER = 'fake-bearer';
export const FAKE_COOKIE_HEADER = 'ctsAuthToken=fake-cts-auth-token; authToken=fake-auth-token';
export const FAKE_HUID = '00000000-0000-4000-8000-000000000000';

/** Тело нужной длины из номера: значение предсказуемо и заведомо не является живым ключом */
function syntheticBody(seed: number, length: number): string {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = (seed * 131 + index * 17) % 256;
  }
  return Buffer.from(bytes).toString('base64');
}

/**
 * Свежий материал на каждый вызов. Общая константа разъехалась бы между тестами:
 * объект отдаётся наружу по ссылке, и один тест, поправивший её, ломал бы соседний.
 */
export function createFakeKeyMaterial(): KeyMaterial {
  return {
    privateKeys: {
      /* Длины как у живых: x25519 это 32 байта, ed25519-приватный это 64 */
      cts: { body: syntheticBody(1, 32), publicKeyId: FAKE_CTS_PUBLIC_KEY_ID },
      rts: { body: syntheticBody(2, 32), publicKeyId: FAKE_RTS_PUBLIC_KEY_ID },
    },
    signKeys: { privateBody: syntheticBody(3, 64), publicId: FAKE_SIGN_PUBLIC_KEY_ID },
    wsParams: { keyId: FAKE_CTS_PUBLIC_KEY_ID, instanceId: 'fake-instance-id' },
  };
}

export interface FakeAuthProviderOptions {
  bearer?: string;
  cookieHeader?: string;
  huid?: string;
  keyMaterial?: KeyMaterial;
}

/** Счётчики обращений: ими доказывается схлопывание входов и число ретраев транспорта */
export interface FakeAuthProviderCalls {
  getBearer: number;
  getCookieHeader: number;
  getWhoami: number;
  getKeyMaterial: number;
  onAuthFailure: number;
}

export class FakeAuthProvider implements AuthProvider {
  readonly calls: FakeAuthProviderCalls = {
    getBearer: 0,
    getCookieHeader: 0,
    getWhoami: 0,
    getKeyMaterial: 0,
    onAuthFailure: 0,
  };

  readonly cookieHeader: string;
  readonly huid: string;
  readonly keyMaterial: KeyMaterial;

  private readonly baseBearer: string;
  private currentBearer: string;
  private rotation = 0;
  private nextBearerFailure: AuthError | undefined;

  constructor(options: FakeAuthProviderOptions = {}) {
    this.baseBearer = options.bearer ?? FAKE_BEARER;
    this.currentBearer = this.baseBearer;
    this.cookieHeader = options.cookieHeader ?? FAKE_COOKIE_HEADER;
    this.huid = options.huid ?? FAKE_HUID;
    this.keyMaterial = options.keyMaterial ?? createFakeKeyMaterial();
  }

  /** Текущий токен без учёта в счётчиках: тесту нужно сверять значение, а не имитировать спрос */
  get bearer(): string {
    return this.currentBearer;
  }

  /**
   * Заряжает ОДИН отказ на ближайший `getBearer()`.
   *
   * Ровно один, потому что проверяемое поведение это «отказ, `onAuthFailure()`, повтор
   * удался»: вечный отказ доказывал бы только то, что ошибка пробрасывается.
   */
  failNextBearer(error: AuthError = new AuthError('подложный отказ авторизации', 'bearer')): void {
    this.nextBearerFailure = error;
  }

  async getBearer(): Promise<string> {
    this.calls.getBearer += 1;
    const failure = this.nextBearerFailure;
    if (failure !== undefined) {
      this.nextBearerFailure = undefined;
      throw failure;
    }
    return this.currentBearer;
  }

  async getCookieHeader(): Promise<string> {
    this.calls.getCookieHeader += 1;
    return this.cookieHeader;
  }

  async getWhoami(): Promise<Whoami> {
    this.calls.getWhoami += 1;
    return { huid: this.huid };
  }

  async getKeyMaterial(): Promise<KeyMaterial> {
    this.calls.getKeyMaterial += 1;
    return this.keyMaterial;
  }

  /** Отказ кред сменяет токен: иначе тест повтора не отличил бы новый токен от старого */
  async onAuthFailure(): Promise<void> {
    this.calls.onAuthFailure += 1;
    this.rotation += 1;
    this.currentBearer = `${this.baseBearer}-${this.rotation}`;
  }
}
