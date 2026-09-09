/**
 * Справка о профилях: разбор ответа, батчи и кэш.
 *
 * Главное здесь не «имя разобралось», а ЦЕНА. Список чатов читается десятками вызовов
 * подряд, и справка без кэша означала бы обращение на каждый вызов, а справка без батча
 * обращение на каждого человека. Поэтому проверки считают обращения, а не только имена.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { fetchProfilesByHuids, resetProfileCache, PROFILE_BATCH_LIMIT } from '../../src/protocol/profiles.js';
import type { RestClient } from '../../src/transport/types.js';
import { createLogger } from '../../src/util/logger.js';
import { FakeProfilesRest } from '../helpers/fakeRest.js';
import {
  makeProfilesResponse,
  PEER_HUID,
  SECOND_PEER_HUID,
  NAMELESS_PEER_HUID,
  type ProfileFixture,
} from '../helpers/readFixtures.js';
import { createTestConfig } from '../helpers/testConfig.js';

const PROFILES: ProfileFixture[] = [
  {
    huid: PEER_HUID,
    name: 'Тестов Тест Тестович',
    companyPosition: 'Инженер',
    department: 'Отдел проб',
    company: 'Пробная компания',
    email: 'testov@example.test',
  },
  { huid: SECOND_PEER_HUID, name: 'Пробова Проба Пробовна' },
];

function createDeps(rest: RestClient, profileCacheTtlMs?: number) {
  return {
    rest,
    config: createTestConfig(
      profileCacheTtlMs === undefined ? {} : { limits: { profileCacheTtlMs } },
    ),
    logger: createLogger({ level: 'error' }),
  };
}

beforeEach(() => {
  resetProfileCache();
});

describe('разбор ответа справки', () => {
  it('собирает профиль со всеми снятыми живьём полями', async () => {
    const rest = new FakeProfilesRest(PROFILES);

    const found = await fetchProfilesByHuids(createDeps(rest), [PEER_HUID]);

    expect(found.get(PEER_HUID)).toEqual({
      huid: PEER_HUID,
      name: 'Тестов Тест Тестович',
      company: 'Пробная компания',
      company_position: 'Инженер',
      department: 'Отдел проб',
      email: 'testov@example.test',
    });
  });

  it('собирает профили со ВСЕХ серверных групп ответа, а не только из первой', async () => {
    const rest: RestClient = {
      getJson: async () => {
        throw new Error('GET здесь не участвует');
      },
      postJson: async <T>() =>
        makeProfilesResponse([[PROFILES[0]!], [PROFILES[1]!]]) as T,
      getKdcKeys: async () => [],
    };

    const found = await fetchProfilesByHuids(createDeps(rest), [PEER_HUID, SECOND_PEER_HUID]);

    expect([...found.keys()].sort()).toEqual([PEER_HUID, SECOND_PEER_HUID].sort());
  });

  it('запись без адреса или без имени пропускается, а соседние не страдают', async () => {
    const rest: RestClient = {
      getJson: async () => {
        throw new Error('GET здесь не участвует');
      },
      postJson: async <T>() =>
        ({
          status: 'ok',
          result: [
            {
              cts_profiles: [
                { user_huid: NAMELESS_PEER_HUID },
                { name: 'Имя без адреса' },
                { user_huid: PEER_HUID, name: 'Тестов Тест Тестович' },
              ],
            },
          ],
        }) as T,
      getKdcKeys: async () => [],
    };

    const found = await fetchProfilesByHuids(createDeps(rest), [PEER_HUID, NAMELESS_PEER_HUID]);

    expect(found.size).toBe(1);
    expect(found.get(PEER_HUID)?.name).toBe('Тестов Тест Тестович');
  });

  it('неизвестная форма ответа это пустая справка, а не отказ', async () => {
    const rest: RestClient = {
      getJson: async () => {
        throw new Error('GET здесь не участвует');
      },
      postJson: async <T>() => ({ status: 'ok' }) as T,
      getKdcKeys: async () => [],
    };

    await expect(fetchProfilesByHuids(createDeps(rest), [PEER_HUID])).resolves.toEqual(new Map());
  });
});

describe('цена обращения', () => {
  it('пустой список не превращается в запрос', async () => {
    const rest = new FakeProfilesRest(PROFILES);

    const found = await fetchProfilesByHuids(createDeps(rest), []);

    expect(found.size).toBe(0);
    expect(rest.calls).toHaveLength(0);
  });

  it('повторы в списке спрашиваются один раз', async () => {
    const rest = new FakeProfilesRest(PROFILES);

    await fetchProfilesByHuids(createDeps(rest), [PEER_HUID, PEER_HUID, PEER_HUID]);

    expect(rest.calls[0]?.huids).toEqual([PEER_HUID]);
  });

  it('длинный список режется на батчи не длиннее потолка', async () => {
    const rest = new FakeProfilesRest(PROFILES);
    const many = Array.from(
      { length: PROFILE_BATCH_LIMIT + 5 },
      (_, index) => `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
    );

    await fetchProfilesByHuids(createDeps(rest), many);

    expect(rest.calls).toHaveLength(2);
    expect(rest.calls[0]?.huids).toHaveLength(PROFILE_BATCH_LIMIT);
    expect(rest.calls[1]?.huids).toHaveLength(5);
  });

  it('второй запрос о тех же людях идёт из кэша и на сервер не уходит', async () => {
    const rest = new FakeProfilesRest(PROFILES);
    const deps = createDeps(rest);

    await fetchProfilesByHuids(deps, [PEER_HUID, SECOND_PEER_HUID]);
    const again = await fetchProfilesByHuids(deps, [PEER_HUID, SECOND_PEER_HUID]);

    expect(rest.calls).toHaveLength(1);
    expect(again.get(PEER_HUID)?.name).toBe('Тестов Тест Тестович');
  });

  it('спрашивается только то, чего в кэше нет', async () => {
    const rest = new FakeProfilesRest(PROFILES);
    const deps = createDeps(rest);

    await fetchProfilesByHuids(deps, [PEER_HUID]);
    await fetchProfilesByHuids(deps, [PEER_HUID, SECOND_PEER_HUID]);

    expect(rest.calls.map((call) => call.huids)).toEqual([[PEER_HUID], [SECOND_PEER_HUID]]);
  });

  /* Нулевой срок жизни ВЫКЛЮЧАЕТ кэш: значение из конфига, а не зашитое число */
  it('при нулевом сроке жизни кэша каждый вызов спрашивает заново', async () => {
    const rest = new FakeProfilesRest(PROFILES);
    const deps = createDeps(rest, 0);

    await fetchProfilesByHuids(deps, [PEER_HUID]);
    await fetchProfilesByHuids(deps, [PEER_HUID]);

    expect(rest.calls).toHaveLength(2);
  });

  /*
   * Промах запоминается наравне с попаданием: иначе один собеседник, которого справка не
   * знает, стоил бы обращения на каждый вызов списка чатов. Срок жизни записи ограничивает
   * размен: появившийся профиль подхватится следующим сроком.
   */
  it('не найденный профиль тоже запоминается и второй раз не спрашивается', async () => {
    const rest = new FakeProfilesRest(PROFILES);
    const deps = createDeps(rest);

    const first = await fetchProfilesByHuids(deps, [NAMELESS_PEER_HUID]);
    const again = await fetchProfilesByHuids(deps, [NAMELESS_PEER_HUID]);

    expect(first.has(NAMELESS_PEER_HUID)).toBe(false);
    expect(again.has(NAMELESS_PEER_HUID)).toBe(false);
    expect(rest.calls).toHaveLength(1);
  });
});
