/**
 * Публичные ключи получателей через KDC.
 *
 * Получатели берутся ТОЛЬКО из `chat.keys`, то есть из списка, который пришёл вместе с чатом,
 * и их тела приезжают из KDC. Подстановка локального материала здесь была бы не оптимизацией,
 * а отказом отправки: живая проба на обёртке по своему профилю дала `invalid_keys`.
 */
import type { RestClient } from '../transport/types.js';
import type { CryptoKeys, RecipientPublicKey } from './types.js';
import { decodeBase64, ensureSodiumReady } from './sodium.js';

/**
 * KDC не знает запрошенного ключа.
 *
 * Диагноз перечисляет идентификаторы, которых не хватило, и весь запрошенный список:
 * без первого непонятно, что чинить, без второго непонятно, откуда взялся лишний ключ.
 */
export class KeyResolutionError extends Error {
  constructor(
    readonly missingKeyIds: readonly string[],
    readonly requestedKeyIds: readonly string[],
  ) {
    super(
      `KDC не отдал публичные ключи: ${missingKeyIds.join(', ')}. ` +
        `Запрошены были: ${requestedKeyIds.join(', ')}. ` +
        'Список получателей приходит вместе с чатом, поэтому расхождение означает устаревший ' +
        'список чатов либо ротацию ключа: перечитайте чаты и повторите.',
    );
    this.name = 'KeyResolutionError';
  }
}

export class KdcKeys implements CryptoKeys {
  /**
   * Кэш публичных тел на время жизни сервиса. Публичные ключи не секрет, а KDC зовётся на
   * каждую отправку и на каждое входящее событие: без кэша это запрос на сообщение.
   */
  private readonly bodies = new Map<string, Uint8Array>();

  constructor(private readonly rest: RestClient) {}

  async resolveRecipientPublicKeys(keyIds: readonly string[]): Promise<RecipientPublicKey[]> {
    await ensureSodiumReady();

    const unknown = [...new Set(keyIds)].filter((keyId) => !this.bodies.has(keyId));
    if (unknown.length > 0) {
      for (const key of await this.rest.getKdcKeys(unknown)) {
        this.bodies.set(key.key_id, decodeBase64(key.body));
      }
    }

    /* Порядок ответа KDC не совпадает с порядком запроса: живьём он приходил перевёрнутым */
    const resolved: RecipientPublicKey[] = [];
    const missing: string[] = [];
    for (const keyId of keyIds) {
      const body = this.bodies.get(keyId);
      if (body) {
        resolved.push({ keyId, body });
      } else {
        missing.push(keyId);
      }
    }
    if (missing.length > 0) {
      throw new KeyResolutionError(missing, keyIds);
    }
    return resolved;
  }

  async senderPublicKey(keyId: string): Promise<Uint8Array> {
    const resolved = await this.resolveRecipientPublicKeys([keyId]);
    const entry = resolved[0];
    if (!entry) {
      throw new KeyResolutionError([keyId], [keyId]);
    }
    return entry.body;
  }
}
