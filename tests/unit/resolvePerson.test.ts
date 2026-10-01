/**
 * Адресация человека для упоминания: только участники чата, три исхода и отказ гадать.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resolvePerson } from '../../src/chat/resolvePerson.js';
import type { ChatRecord } from '../../src/protocol/chatShape.js';
import { resetProfileCache, type ProfilesDeps } from '../../src/protocol/profiles.js';
import { createLogger } from '../../src/util/logger.js';
import { FakeProfilesRest } from '../helpers/fakeRest.js';
import {
  MY_HUID,
  NAMELESS_PEER_HUID,
  PEER_HUID,
  POLYGON_CHAT_ID,
  SECOND_PEER_HUID,
  type ProfileFixture,
} from '../helpers/readFixtures.js';
import { createTestConfig } from '../helpers/testConfig.js';

/** Человек со справкой, но вне чата: его huid обязан давать промах */
const OUTSIDER_HUID = '77777777-7777-5777-8777-777777777777';

/** Имена синтетические: фикстуры лежат в репозитории */
const PROFILES: ProfileFixture[] = [
  { huid: MY_HUID, name: 'Проверкин Иван Сергеевич' },
  { huid: PEER_HUID, name: 'Тестов Тест Тестович' },
  { huid: SECOND_PEER_HUID, name: 'Тестов Пётр Петрович' },
  { huid: OUTSIDER_HUID, name: 'Сторонний Посторонний' },
];

const CHAT: ChatRecord = {
  chat_id: POLYGON_CHAT_ID,
  name: 'Дежурка',
  kind: 'group_chat',
  key_ids: ['recipient-key-id-a'],
  member_huids: [MY_HUID, PEER_HUID, SECOND_PEER_HUID, NAMELESS_PEER_HUID],
  is_self: false,
};

function createDeps(): ProfilesDeps {
  return {
    rest: new FakeProfilesRest(PROFILES),
    config: createTestConfig(),
    logger: createLogger({ level: 'error' }),
  };
}

beforeEach(() => {
  resetProfileCache();
});

describe('resolvePerson', () => {
  it('huid участника разрешается в него самого с именем из справки', async () => {
    const result = await resolvePerson(createDeps(), CHAT, PEER_HUID.toUpperCase());
    expect(result).toEqual({
      kind: 'resolved',
      person: { huid: PEER_HUID, name: 'Тестов Тест Тестович' },
    });
  });

  it('однозначное имя разрешается без учёта регистра, полным именем и набором слов', async () => {
    const expected = { kind: 'resolved', person: { huid: PEER_HUID, name: 'Тестов Тест Тестович' } };
    expect(await resolvePerson(createDeps(), CHAT, 'тестов тест тестович')).toEqual(expected);
    expect(await resolvePerson(createDeps(), CHAT, 'Тест Тестов')).toEqual(expected);
    expect(await resolvePerson(createDeps(), CHAT, 'Иван')).toEqual({
      kind: 'resolved',
      person: { huid: MY_HUID, name: 'Проверкин Иван Сергеевич' },
    });
  });

  it('два совпадения дают неоднозначность с обоими кандидатами', async () => {
    const result = await resolvePerson(createDeps(), CHAT, 'Тестов');
    expect(result).toEqual({
      kind: 'ambiguous',
      candidates: [
        { huid: PEER_HUID, name: 'Тестов Тест Тестович' },
        { huid: SECOND_PEER_HUID, name: 'Тестов Пётр Петрович' },
      ],
    });
  });

  it('ноль совпадений и часть слова дают промах', async () => {
    expect((await resolvePerson(createDeps(), CHAT, 'Бухгалтеров')).kind).toBe('not_found');
    expect((await resolvePerson(createDeps(), CHAT, 'Тес')).kind).toBe('not_found');
    expect((await resolvePerson(createDeps(), CHAT, 'Сторонний')).kind).toBe('not_found');
  });

  it('huid не из этого чата и участник без имени в справке дают промах', async () => {
    const outsider = await resolvePerson(createDeps(), CHAT, OUTSIDER_HUID);
    expect(outsider.kind).toBe('not_found');
    expect(outsider.kind === 'not_found' && outsider.reason).toContain(OUTSIDER_HUID);

    expect((await resolvePerson(createDeps(), CHAT, NAMELESS_PEER_HUID)).kind).toBe('not_found');
  });
});
