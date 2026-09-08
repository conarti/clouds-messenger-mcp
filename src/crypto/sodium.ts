/**
 * Общий низ крипто-слоя: единственная точка ожидания libsodium и кодеки base64.
 *
 * Вынесено отдельно, потому что расшифровка, шифрование, подпись и резолв ключей делают
 * ровно эти вещи одинаково, а разъехавшиеся копии кодека дают худший класс отказов:
 * тег не сходится, а причина по симптому не видна.
 */
import sodium from 'libsodium-wrappers-sumo';

/**
 * Алгоритм обёртки и тела, наблюдённый на проводе: xchacha20-poly1305-ietf со связанными
 * данными. Строка едет в кадре как есть, поэтому живёт ровно здесь и нигде больше.
 */
export const CONTENT_ALGO_AEAD = 'xsalsa20:xchacha20_aead_ietf';

/** Нонс и у обёртки crypto_box, и у тела AEAD: 24 байта префиксом перед шифротекстом */
export const NONCE_BYTES = 24;

/** Контент-ключ: 32 случайных байта на каждое сообщение */
export const CONTENT_KEY_BYTES = 32;

let readiness: Promise<void> | undefined;

/**
 * Готовность wasm ожидается лениво и один раз на процесс.
 *
 * До готовности методы модуля ещё не подставлены, и вызов без ожидания падает не там,
 * где ошибка: обёртка делает это требование явным для каждого входа в слой.
 */
export function ensureSodiumReady(): Promise<void> {
  readiness ??= sodium.ready;
  return readiness;
}

/**
 * Декодер base64, устойчивый к отсутствию хвостового паддинга.
 *
 * Клиент пишет вариант ORIGINAL, но значения без '=' на проводе встречаются, и строгий
 * разбор такого значения дал бы отказ вместо расшифровки.
 */
export function decodeBase64(value: string): Uint8Array {
  try {
    return sodium.from_base64(value, sodium.base64_variants.ORIGINAL);
  } catch {
    return sodium.from_base64(value, sodium.base64_variants.ORIGINAL_NO_PADDING);
  }
}

/** Кодировать обратно всегда в ORIGINAL: именно этот вариант принимает сервер */
export function encodeBase64(bytes: Uint8Array): string {
  return sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
}

/**
 * Связанные данные AEAD: идентификатор чата и sync_id через двоеточие.
 *
 * Тег считается вместе с ними, поэтому расхождение любого из двух идентификаторов это
 * не «другой контекст», а нерасшифровка. Шаблон живёт только здесь.
 */
export function buildAdditionalData(groupChatId: string, syncId: string): string {
  return `${groupChatId}:${syncId}`;
}

/** Нонс едет префиксом перед шифротекстом: и в обёртке ключа, и в теле события */
export function prefixWithNonce(nonce: Uint8Array, cipher: Uint8Array): Uint8Array {
  const result = new Uint8Array(nonce.length + cipher.length);
  result.set(nonce);
  result.set(cipher, nonce.length);
  return result;
}
