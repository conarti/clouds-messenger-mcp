/**
 * Расшифровка страницы истории.
 *
 * ГЛАВНОЕ: неудача на ОДНОМ событии не роняет страницу. Событие остаётся в выдаче с
 * пометкой `decrypt_error`, потому что молча исчезнувшее сообщение хуже нечитаемого:
 * вызывающий увидит дыру в переписке и примет её за факт, а курсор пагинации при этом
 * съедет на элемент, которого он не видел.
 *
 * Ключевой материал сюда не приходит и отсюда не уходит: приватная половина берётся у
 * хранилища по идентификатору из самого события, публичная половина отправителя у KDC.
 */
import type { KeyStore } from '../auth/keyStore.js';
import type { CryptoService, EncryptedEventRef } from '../crypto/types.js';
import type { Logger } from '../util/logger.js';
import { asObject, stringOr } from '../util/json.js';
import { describeError } from './errors.js';
import { normalizeEvent, type Message } from './messageShape.js';

export interface DecryptHistoryDeps {
  crypto: CryptoService;
  keyStore: KeyStore;
  logger: Logger;
}

export interface DecryptedEvent {
  /** Внешнее событие как приехало: адрес, метки, активности и прочтения лежат в нём */
  raw: Record<string, unknown>;
  /** Внутреннее событие, если расшифровка удалась */
  inner?: Record<string, unknown>;
  /** Текст отказа с тегом слоя, если не удалась */
  error?: string;
}

/** Собирает ссылку на зашифрованное событие; неполное событие расшифровке не подлежит */
function toEncryptedRef(event: Record<string, unknown>): EncryptedEventRef | undefined {
  const key = asObject(event['key']);
  const groupChatId = stringOr(event['group_chat_id']);
  const syncId = stringOr(event['sync_id']);
  const senderKeyId = stringOr(event['sender_key_id']);
  const keyId = stringOr(key?.['key_id']);
  const keyBody = stringOr(key?.['key']);
  const algo = stringOr(key?.['algo']);
  const payload = stringOr(event['payload']);
  if (
    groupChatId === undefined ||
    syncId === undefined ||
    senderKeyId === undefined ||
    keyId === undefined ||
    keyBody === undefined ||
    algo === undefined ||
    payload === undefined
  ) {
    return undefined;
  }
  return {
    group_chat_id: groupChatId,
    sync_id: syncId,
    sender_key_id: senderKeyId,
    key: { key_id: keyId, key: keyBody, algo },
    payload,
  };
}

async function decryptOne(
  deps: DecryptHistoryDeps,
  event: Record<string, unknown>,
): Promise<DecryptedEvent> {
  const reference = toEncryptedRef(event);
  if (reference === undefined) {
    return {
      raw: event,
      error:
        '[client] decrypt: событие пришло без полного конверта (ключ, sender_key_id либо payload), ' +
        'расшифровать его нечем',
    };
  }
  try {
    const recipientPrivateKey = await deps.keyStore.require(reference.key.key_id);
    const senderPublicKey = await deps.crypto.keys.senderPublicKey(reference.sender_key_id);
    const inner = await deps.crypto.decryptEvent(reference, { recipientPrivateKey, senderPublicKey });
    return { raw: event, inner };
  } catch (error) {
    return { raw: event, error: describeError(error).message };
  }
}

/**
 * Страница целиком. Последовательно, а не параллельно: KDC отдаёт публичные тела с кэшем,
 * и параллельный старт на холодном кэше сделал бы по запросу на событие вместо одного.
 */
export async function decryptHistoryEvents(
  deps: DecryptHistoryDeps,
  events: readonly Record<string, unknown>[],
): Promise<DecryptedEvent[]> {
  const decrypted: DecryptedEvent[] = [];
  for (const event of events) {
    decrypted.push(await decryptOne(deps, event));
  }
  const failed = decrypted.filter((entry) => entry.error !== undefined).length;
  if (failed > 0) {
    deps.logger.warn('часть событий не расшифрована', { total: decrypted.length, failed });
  }
  return decrypted;
}

/**
 * Расшифрованные события в единую форму сообщения.
 *
 * Событие, которое нечем адресовать, выпадает; событие, которое не расшифровалось,
 * остаётся с пометкой. Это разные случаи: во втором сообщение существует и адресуемо,
 * а в первом его нельзя ни показать, ни передать курсором.
 */
export function toMessages(decrypted: readonly DecryptedEvent[]): Message[] {
  return decrypted.flatMap((entry) => {
    const message = normalizeEvent(entry.raw, entry);
    return message === undefined ? [] : [message];
  });
}
