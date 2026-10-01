/**
 * Адресация человека для упоминания: строка (huid либо имя) -> `{ huid, name }`.
 *
 * ИСТОЧНИК ЛЮДЕЙ ЭТО УЧАСТНИКИ ЧАТА. Упоминают в группе, где у коллег может не быть личного
 * чата со мной, поэтому имена берутся из справки о профилях по `member_huids` резолвнутого
 * чата, а не из списка личных чатов. Человек вне чата не упоминается вовсе.
 *
 * ГАДАТЬ ЗАПРЕЩЕНО, как и в `resolveChat`: несколько совпадений уходят наружу кандидатами,
 * выбор делает вызывающий. Ошибка здесь означает уведомление не тому человеку.
 *
 * ПРАВИЛО ИМЕНИ консервативное: сравнение без учёта регистра, сначала полное имя целиком,
 * затем набор ЦЕЛЫХ слов в любом порядке (имя без отчества, одно имя). Подстрока слова не
 * считается совпадением: «Ив» не находит «Иван», иначе короткий запрос цеплял бы случайных
 * людей. Одно слово, совпавшее у двоих, даёт неоднозначность, а не первого попавшегося.
 */
import type { ChatRecord } from '../protocol/chatShape.js';
import { UUID_PATTERN, type Mention } from '../protocol/messageShape.js';
import { fetchProfilesByHuids, type ProfilesDeps } from '../protocol/profiles.js';

export type ResolvePersonResult =
  | { kind: 'resolved'; person: Mention }
  | { kind: 'ambiguous'; candidates: Mention[] }
  | { kind: 'not_found'; reason: string };

function wordsOf(value: string): string[] {
  return value
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

function decide(matched: readonly Mention[], reason: string): ResolvePersonResult {
  const single = matched[0];
  if (matched.length === 1 && single !== undefined) {
    return { kind: 'resolved', person: single };
  }
  if (matched.length > 1) {
    return { kind: 'ambiguous', candidates: [...matched] };
  }
  return { kind: 'not_found', reason };
}

export async function resolvePerson(
  deps: ProfilesDeps,
  chat: ChatRecord,
  query: string,
): Promise<ResolvePersonResult> {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return { kind: 'not_found', reason: 'пустая строка: упомянуть некого' };
  }

  const memberHuids = chat.member_huids;
  if (UUID_PATTERN.test(trimmed)) {
    const lowered = trimmed.toLowerCase();
    const member = memberHuids.find((candidate) => candidate.toLowerCase() === lowered);
    if (member === undefined) {
      return {
        kind: 'not_found',
        reason: `huid ${trimmed} не входит в участники чата ${chat.chat_id}`,
      };
    }
    const name = (await fetchProfilesByHuids(deps, [member])).get(member)?.name;
    /* Имя едет в само упоминание и ищется в тексте: придуманное имя хуже отказа */
    if (name === undefined || name.length === 0) {
      return {
        kind: 'not_found',
        reason: `справка о профилях не назвала имя участника ${member}, упоминание собрать не из чего`,
      };
    }
    return { kind: 'resolved', person: { huid: member, name } };
  }

  const profiles = await fetchProfilesByHuids(deps, memberHuids);
  const people: Mention[] = memberHuids.flatMap((huid) => {
    const name = profiles.get(huid)?.name;
    return name === undefined || name.length === 0 ? [] : [{ huid, name }];
  });

  const queryWords = wordsOf(trimmed);
  const fullName = queryWords.join(' ');
  const exact = people.filter((person) => wordsOf(person.name).join(' ') === fullName);
  if (exact.length > 0) {
    return decide(exact, '');
  }

  return decide(
    people.filter((person) => {
      const nameWords = new Set(wordsOf(person.name));
      return queryWords.every((word) => nameWords.has(word));
    }),
    `среди участников чата ${chat.chat_id} нет человека «${trimmed}» ни по полному имени, ` +
      'ни по набору целых слов имени',
  );
}
