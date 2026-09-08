import type { AuthProvider, KeyMaterial } from './AuthProvider.js';

/**
 * Матч идентификатора ключа из события на приватный ключ сессии.
 *
 * Хранилище НЕ читает профиль само: материал приезжает через `AuthProvider.getKeyMaterial()`,
 * который остаётся единственным владельцем доступа к IndexedDB. Здесь только сопоставление
 * `key_id` события с `publicKeyId` из {@link KeyMaterial}, поэтому граф зависимостей
 * остаётся ациклическим: крипто не импортирует хранилище, хранилище не импортирует крипто.
 */
export interface KeyStore {
  /** Приватный ключ под идентификатор публичной половины; отсутствие это штатный ответ */
  match(keyId: string): Promise<Uint8Array | undefined>;
  /** То же, но отсутствие ключа это отказ с диагнозом: см. {@link KeyNotFoundError} */
  require(keyId: string): Promise<Uint8Array>;
}

/**
 * Ключ не найден.
 *
 * Диагноз перечисляет ИЗВЕСТНЫЕ идентификаторы публичных половин, но никогда не тела ключей:
 * расхождение key_id это самая частая причина нерасшифровки, и без списка отладка сводится
 * к гаданию, а тело ключа в тексте ошибки уехало бы в лог и в баг-репорт.
 */
export class KeyNotFoundError extends Error {
  constructor(
    readonly keyId: string,
    readonly knownPublicKeyIds: readonly string[],
  ) {
    super(
      `Ключ ${keyId} не найден в материале сессии. Известные публичные идентификаторы: ` +
        `${knownPublicKeyIds.length > 0 ? knownPublicKeyIds.join(', ') : 'ни одного'}. ` +
        'Событие зашифровано на другую сессию либо профиль устарел: переавторизуйтесь.',
    );
    this.name = 'KeyNotFoundError';
  }
}

/**
 * Хранилище поверх порта авторизации.
 *
 * Материал берётся у `AuthProvider` на каждом обращении, а не кэшируется здесь: кэш сессии
 * живёт у провайдера, и вторая копия рядом пережила бы инвалидацию после `onAuthFailure()`,
 * то есть молча подставляла бы ключи отозванной сессии.
 */
export class AuthKeyStore implements KeyStore {
  constructor(private readonly auth: Pick<AuthProvider, 'getKeyMaterial'>) {}

  async match(keyId: string): Promise<Uint8Array | undefined> {
    const material = await this.auth.getKeyMaterial();
    return findPrivateKey(material, keyId);
  }

  async require(keyId: string): Promise<Uint8Array> {
    const material = await this.auth.getKeyMaterial();
    const found = findPrivateKey(material, keyId);
    if (found === undefined) {
      throw new KeyNotFoundError(keyId, knownPublicKeyIds(material));
    }
    return found;
  }
}

/** Виды ключей обмена. Перечислены явно: порядок перебора обязан быть детерминированным */
const PRIVATE_KEY_KINDS = ['cts', 'rts'] as const;

function findPrivateKey(material: KeyMaterial, keyId: string): Uint8Array | undefined {
  for (const kind of PRIVATE_KEY_KINDS) {
    const entry = material.privateKeys[kind];
    if (entry !== undefined && entry.publicKeyId === keyId) {
      /*
       * Копия, а не сам буфер: `Buffer.from` берёт память из общего пула Node, и отданный
       * наружу срез разделял бы её с посторонними буферами.
       */
      return Uint8Array.from(Buffer.from(entry.body, 'base64'));
    }
  }
  return undefined;
}

function knownPublicKeyIds(material: KeyMaterial): string[] {
  return PRIVATE_KEY_KINDS.flatMap((kind) => {
    const entry = material.privateKeys[kind];
    return entry === undefined ? [] : [entry.publicKeyId];
  });
}
