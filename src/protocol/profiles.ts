/**
 * Профили людей по huid: единственный источник имён собеседников.
 *
 * ИМЯ ЛИЧНОГО ЧАТА НА ПРОВОДЕ ЭТО НЕ ИМЯ. Сервер отдаёт всем личным чатам одинаковое
 * `name` вида «personal chat» (наблюдено живьём), а имя собеседника веб-клиент вычисляет
 * из профиля участника. Значит, без этой справки список чатов состоит из неотличимых
 * друг от друга строк, и адресовать чат по имени человека невозможно.
 *
 * ГЛОБАЛЬНОГО ПОИСКА ЛЮДЕЙ ЗДЕСЬ НЕТ. Ручка спрашивается СПИСКОМ huid и отвечает только
 * про них: искать человека по строке ей нечем. Поэтому справка умеет ровно одно, назвать
 * уже известных людей, и выдавать её за поиск было бы обещанием, которого она не несёт.
 *
 * ОТВЕТ ГРУППИРУЕТСЯ ПО СЕРВЕРАМ. Профили лежат не плоским списком, а внутри `result[]`,
 * где каждый элемент это один сервер со своим `cts_profiles[]`. Живая проба вернула одну
 * группу, но собирать нужно со всех: единственная группа это свойство маленькой пробы,
 * а не обещание формы.
 */
import type { Config } from '../config/types.js';
import type { RestClient } from '../transport/types.js';
import { asObject, stringOr } from '../util/json.js';
import type { Logger } from '../util/logger.js';

/** Профиль человека: только то, чем его называют и по чему его ищут глазами */
export interface Profile {
  huid: string;
  name: string;
  company?: string;
  company_position?: string;
  department?: string;
  email?: string;
}

export interface ProfilesDeps {
  rest: RestClient;
  config: Config;
  logger: Logger;
}

/**
 * Потолок батча. Живая проба ходила пятёркой, поведение ручки на длинном списке не
 * снято, поэтому список режется заведомо безопасной сотней: отказ по длине тела означал
 * бы список чатов вообще без имён, а не одно не названное имя.
 */
export const PROFILE_BATCH_LIMIT = 100;

/** Запись кэша; `profile` отсутствует у промаха, и это тоже знание, а не пустота */
interface CacheEntry {
  profile?: Profile;
  expiresAt: number;
}

/**
 * Кэш на процесс. Живёт модульным состоянием намеренно: сервер MCP это один процесс на
 * одну учётную запись, а имена людей меняются несопоставимо реже, чем читается список
 * чатов.
 *
 * Промах запоминается наравне с попаданием, и это осознанный размен. Иначе один
 * собеседник, которого справка не знает (уволенный, внешний, скрытый), стоил бы обращения
 * на КАЖДЫЙ вызов списка чатов до скончания века. Цена размена ограничена сроком жизни
 * записи: появившийся профиль подхватится следующим сроком, а не остаётся неизвестным навсегда.
 */
const cache = new Map<string, CacheEntry>();

/** Сброс кэша: нужен проверкам, чтобы соседние прогоны не подсказывали друг другу ответ */
export function resetProfileCache(): void {
  cache.clear();
}

/** Разбирает одну запись профиля; запись без huid или без имени бесполезна и пропускается */
function toProfile(raw: unknown): Profile | undefined {
  const record = asObject(raw);
  if (record === undefined) {
    return undefined;
  }
  const huid = stringOr(record['user_huid']);
  const name = stringOr(record['name']);
  if (huid === undefined || name === undefined) {
    return undefined;
  }
  const company = stringOr(record['company']);
  const position = stringOr(record['company_position']);
  const department = stringOr(record['department']);
  const email = stringOr(record['email']);
  return {
    huid,
    name,
    ...(company !== undefined ? { company } : {}),
    ...(position !== undefined ? { company_position: position } : {}),
    ...(department !== undefined ? { department } : {}),
    ...(email !== undefined ? { email } : {}),
  };
}

/** Профили со ВСЕХ серверных групп ответа: одна группа это свойство пробы, а не формы */
function extractProfiles(body: unknown): Profile[] {
  const groups = asObject(body)?.['result'];
  if (!Array.isArray(groups)) {
    return [];
  }
  return groups.flatMap((group) => {
    const rows = asObject(group)?.['cts_profiles'];
    if (!Array.isArray(rows)) {
      return [];
    }
    return rows.flatMap((row) => {
      const profile = toProfile(row);
      return profile === undefined ? [] : [profile];
    });
  });
}

function chunk(values: readonly string[], size: number): string[][] {
  const chunks: string[][] = [];
  for (let start = 0; start < values.length; start += size) {
    chunks.push(values.slice(start, start + size));
  }
  return chunks;
}

/**
 * Профили по списку huid, кэш поверх сети.
 *
 * Пустой список не превращается в вызов: спросить про никого значит потратить обращение
 * на заведомо пустой ответ.
 */
export async function fetchProfilesByHuids(
  deps: ProfilesDeps,
  huids: readonly string[],
): Promise<Map<string, Profile>> {
  const found = new Map<string, Profile>();
  const wanted = [...new Set(huids.filter((value) => value.length > 0))];
  if (wanted.length === 0) {
    return found;
  }

  const now = Date.now();
  const missing: string[] = [];
  for (const huid of wanted) {
    const cached = cache.get(huid);
    if (cached === undefined || cached.expiresAt <= now) {
      missing.push(huid);
      continue;
    }
    if (cached.profile !== undefined) {
      found.set(huid, cached.profile);
    }
  }
  if (missing.length === 0) {
    deps.logger.debug('профили: все запрошенные взяты из кэша', { requested: wanted.length });
    return found;
  }

  const ttl = deps.config.limits.profileCacheTtlMs;
  let requests = 0;
  for (const batch of chunk(missing, PROFILE_BATCH_LIMIT)) {
    const body = await deps.rest.postJson<unknown>(deps.config.protocol.phonebookProfilesPath, {
      huids: batch,
    });
    requests += 1;
    const profiles = extractProfiles(body);
    for (const profile of profiles) {
      found.set(profile.huid, profile);
    }
    if (ttl > 0) {
      const expiresAt = Date.now() + ttl;
      /* Записываются и названные, и не названные: молчание справки это тоже её ответ */
      for (const huid of batch) {
        const profile = found.get(huid);
        cache.set(huid, { ...(profile !== undefined ? { profile } : {}), expiresAt });
      }
    }
  }

  deps.logger.debug('профили получены', {
    requested: wanted.length,
    fromCache: wanted.length - missing.length,
    requests,
    resolved: found.size,
  });
  return found;
}
