/**
 * Расшифровка страницы истории.
 *
 * ГЛАВНОЕ: неудача на ОДНОМ событии не роняет страницу. Событие остаётся в выдаче с
 * пометкой `decrypt_error`, потому что молча исчезнувшее сообщение хуже нечитаемого:
 * вызывающий увидит дыру в переписке и примет её за факт, а курсор пагинации при этом
 * съедет на элемент, которого он не видел.
 *
 * СЛОЙ ОТКАЗА ЗАПОМИНАЕТСЯ ОТДЕЛЬНО ОТ ТЕКСТА, А КОД ОТКАЗА ОТДЕЛЬНО ОТ СЛОЯ. Отказ службы
 * ключей, обрыв сокета, отказ авторизации на пути ключа и не тот ключ читателя приезжают
 * сюда одним путём, и наружу все уезжают внутри `status:"ok"`. Решающая разница не
 * совпадает со слоем: слои `rest` и `phoenix` лечатся повтором всегда, слой `client` лечится
 * повтором только когда отказ это устаревшая сессия (код начинается с `auth_`, поможет
 * переподъём профиля), а не тот ключ переписки повтором не лечится ничем. Разбирать это из
 * текста ошибки нельзя, поэтому и слой, и код едут отдельными полями и попадают в сводку.
 *
 * Ключевой материал сюда не приходит и отсюда не уходит: приватная половина берётся у
 * хранилища по идентификатору из самого события, публичная половина отправителя у KDC.
 */
import type { KeyStore } from '../auth/keyStore.js';
import type { CryptoService, EncryptedEventRef } from '../crypto/types.js';
import type { Logger } from '../util/logger.js';
import { asObject, stringOr } from '../util/json.js';
import { describeError, type ErrorLayer } from './errors.js';
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
  /** Слой того же отказа машинно-читаемо: из текста его разбирать нельзя */
  errorLayer?: ErrorLayer;
  /** Код того же отказа: по нему отличается устаревшая сессия (`auth_*`) от прочего отказа слоя client */
  errorCode?: string;
}

/**
 * Сводка отказов расшифровки по прочитанным событиям. Собирается только когда отказы
 * были: ключ `count: 0` в выдаче читался бы как отдельный факт, а факт здесь один и он
 * в отсутствии ключа.
 */
export interface DecryptErrorSummary {
  /** Сколько событий не расшифровалось среди ПРОЧИТАННЫХ, а не только среди отданных */
  count: number;
  /** Слои отказов без повторов, в устойчивом порядке: по ним видно, что чинить */
  layers: string[];
  /** Отказ службы ключей либо сокета: повтор того же вызова имеет смысл */
  transient: boolean;
}

/**
 * Слои, отказ которых лечится повтором ЦЕЛИКОМ, без разбора кода. Служба ключей и сокет
 * отвечают не всегда, а вот отсутствующий приватный ключ читателя от повтора не появится,
 * поэтому `client` сюда не входит: обещать повтору успех там, где его не будет, хуже, чем
 * промолчать. Отказ авторизации тоже живёт на слое `client`, но лечится повтором ПОСЛЕ
 * переподъёма профиля, поэтому его транзиентность проверяется отдельно, по коду.
 */
const TRANSIENT_LAYERS: readonly ErrorLayer[] = ['rest', 'phoenix'];

/** Префикс кода отказа авторизации: те же коды, что заведены в `AUTH_CODES` в errors.ts */
const AUTH_CODE_PREFIX = 'auth_';

/** Отказ авторизации на пути ключа: сессия устарела, а не то, что ключ переписки не тот */
function isAuthErrorCode(code: string | undefined): boolean {
  return code !== undefined && code.startsWith(AUTH_CODE_PREFIX);
}

/** Подсказка на транзиентный отказ: единственное осмысленное действие вызывающего */
export const DECRYPT_RETRY_NEXT_STEP =
  'часть событий не расшифрована из-за отказа службы ключей, обрыва сокета либо устаревшей ' +
  'сессии, а не из-за ключей переписки: повторите вызов позже тем же курсором';

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
      /* Неполный конверт это свойство самого события: повтор вернёт ровно его же */
      errorLayer: 'client',
    };
  }
  try {
    const recipientPrivateKey = await deps.keyStore.require(reference.key.key_id);
    const senderPublicKey = await deps.crypto.keys.senderPublicKey(reference.sender_key_id);
    const inner = await deps.crypto.decryptEvent(reference, { recipientPrivateKey, senderPublicKey });
    return { raw: event, inner };
  } catch (error) {
    const described = describeError(error);
    return {
      raw: event,
      error: described.message,
      errorLayer: described.layer,
      errorCode: described.code,
    };
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
 * Сводка отказов по странице. `undefined` означает «отказов не было», а не «сводка пуста»:
 * два этих случая различаются наличием ключа в выдаче инструмента.
 */
export function summarizeDecryptErrors(
  decrypted: readonly DecryptedEvent[],
): DecryptErrorSummary | undefined {
  const failed = decrypted.filter((entry) => entry.errorLayer !== undefined);
  if (failed.length === 0) {
    return undefined;
  }
  /* Порядок устойчивый, а не порядок встречи: сводка попадает в выдачу и в проверки */
  const unique = [...new Set(failed.map((entry) => entry.errorLayer as ErrorLayer))].sort();
  const hasAuthFailure = failed.some((entry) => isAuthErrorCode(entry.errorCode));
  return {
    count: failed.length,
    layers: unique,
    transient: unique.some((layer) => TRANSIENT_LAYERS.includes(layer)) || hasAuthFailure,
  };
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
