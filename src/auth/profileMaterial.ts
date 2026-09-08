/**
 * Чистый разбор того, что вынуто из профиля: IndexedDB, url сокета, cookie контекста.
 *
 * Вынесено из адаптера Playwright отдельным модулем, потому что форма хранилищ веб-клиента
 * это самое хрупкое место всей авторизации: она дрейфует с релизами, а поймать дрейф можно
 * только тестом на фикстуре. Браузер в тест не затащить, а фикстуру той же формы, что у
 * оракулов Фазы 0, затащить можно.
 */
import { asObject, stringOr } from '../util/json.js';
import type { PrivateKeyEntry, SignKeys, WsParams } from './AuthProvider.js';

/** Cookie в форме контекста браузера; поля сверх этих разбору не нужны */
export interface ProfileCookie {
  name: string;
  value: string;
  domain: string;
}

/** Ровно то, что лежит в IndexedDB `authState`: ключи обмена и ключи подписи */
export interface AuthStateMaterial {
  privateKeys: {
    cts?: PrivateKeyEntry;
    rts?: PrivateKeyEntry;
  };
  signKeys: SignKeys;
}

/** Виды ключей обмена. Перечислены явно: порядок обхода обязан быть детерминированным */
const PRIVATE_KEY_KINDS = ['cts', 'rts'] as const;

/**
 * Предел обхода. Записи IndexedDB это срез redux-состояния произвольной вложенности,
 * и без предела битая запись с циклом по ссылкам увела бы обход в бесконечность.
 */
const MAX_WALK_DEPTH = 8;

function readPrivateKeyEntry(value: unknown): PrivateKeyEntry | undefined {
  const node = asObject(value);
  if (node === undefined) {
    return undefined;
  }
  const body = stringOr(node['body']);
  const publicKeyId = stringOr(node['publicKeyId']);
  return body !== undefined && publicKeyId !== undefined ? { body, publicKeyId } : undefined;
}

function readSignKeys(value: unknown): SignKeys | undefined {
  const node = asObject(value);
  if (node === undefined) {
    return undefined;
  }
  const privateBody = stringOr(asObject(node['private'])?.['body']);
  const publicId = stringOr(asObject(node['public'])?.['id']);
  return privateBody !== undefined && publicId !== undefined ? { privateBody, publicId } : undefined;
}

/**
 * Узел материала это узел, где лежат ОБА набора сразу.
 *
 * Требовать оба обязательно: без ключей подписи отправка невозможна, и запись, где есть
 * только `privateKeys`, это не пользовательский узел, а обломок другого среза.
 */
function isMaterialNode(node: Record<string, unknown>): boolean {
  return asObject(node['privateKeys']) !== undefined && asObject(node['signKeys']) !== undefined;
}

function findMaterialNode(value: unknown, depth: number): Record<string, unknown> | undefined {
  if (depth > MAX_WALK_DEPTH) {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findMaterialNode(item, depth + 1);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
  const node = asObject(value);
  if (node === undefined) {
    return undefined;
  }
  if (isMaterialNode(node)) {
    return node;
  }
  for (const item of Object.values(node)) {
    const found = findMaterialNode(item, depth + 1);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/**
 * Ключевой материал из записей `authState`/items.
 *
 * Путь к узлу не фиксируется, потому что записи это срез стора: имя обёртки меняется
 * от релиза к релизу, а форма самого узла (`privateKeys` рядом с `signKeys`) устойчива.
 * Отсутствие материала возвращается пустотой, а не исключением: решать, что делать с
 * профилем без ключей, обязан вызывающий, у которого есть контекст попытки входа.
 */
export function extractKeyMaterialFromAuthState(rows: readonly unknown[]): AuthStateMaterial | undefined {
  for (const row of rows) {
    const node = findMaterialNode(row, 0);
    if (node === undefined) {
      continue;
    }
    const signKeys = readSignKeys(node['signKeys']);
    if (signKeys === undefined) {
      continue;
    }
    const source = asObject(node['privateKeys']) ?? {};
    const privateKeys: AuthStateMaterial['privateKeys'] = {};
    for (const kind of PRIVATE_KEY_KINDS) {
      const entry = readPrivateKeyEntry(source[kind]);
      if (entry !== undefined) {
        privateKeys[kind] = entry;
      }
    }
    return { privateKeys, signKeys };
  }
  return undefined;
}

/**
 * Мой huid из записи `profiles` среза redux: запись с `isMe: true`.
 *
 * Именно свой huid отличает своё сообщение от чужого во внутреннем событии, а другого
 * места, где он лежит рядом с признаком «это я», в профиле нет.
 */
export function extractHuidFromProfiles(value: unknown, depth = 0): string | undefined {
  if (depth > MAX_WALK_DEPTH) {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractHuidFromProfiles(item, depth + 1);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
  const node = asObject(value);
  if (node === undefined) {
    return undefined;
  }
  if (node['isMe'] === true) {
    const huid = stringOr(node['userHuid']);
    if (huid !== undefined) {
      return huid;
    }
  }
  for (const item of Object.values(node)) {
    const found = extractHuidFromProfiles(item, depth + 1);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/**
 * Параметры сессии из query реального url сокета.
 *
 * Собрать их самостоятельно нельзя: `key_id` и `instance_id` выдаются конкретной сессии,
 * и подставленное значение даёт не отказ, а молчаливо чужую сессию.
 */
export function parseWsParams(url: string): WsParams | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const keyId = stringOr(parsed.searchParams.get('key_id'));
  const instanceId = stringOr(parsed.searchParams.get('instance_id'));
  return keyId !== undefined && instanceId !== undefined ? { keyId, instanceId } : undefined;
}

/** Стандартный домен-матч cookie: точка в начале домена означает «и все поддомены» */
function domainMatches(cookieDomain: string, host: string): boolean {
  const domain = (cookieDomain.startsWith('.') ? cookieDomain.slice(1) : cookieDomain).toLowerCase();
  const target = host.toLowerCase();
  return target === domain || target.endsWith(`.${domain}`);
}

/**
 * Заголовок Cookie для перечисленных хостов сессии.
 *
 * Фильтр по хостам обязателен: в persistent-профиле лежат и посторонние домены, а лишняя
 * кука в заголовке это чужой секрет, отправленный на наш сервер. Совпадения имён
 * схлопываются: одно и то же имя приезжает и от хоста, и от родительского домена.
 */
export function buildCookieHeader(cookies: readonly ProfileCookie[], hosts: readonly string[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const cookie of cookies) {
    if (seen.has(cookie.name)) {
      continue;
    }
    if (!hosts.some((host) => domainMatches(cookie.domain, host))) {
      continue;
    }
    seen.add(cookie.name);
    parts.push(`${cookie.name}=${cookie.value}`);
  }
  return parts.join('; ');
}
