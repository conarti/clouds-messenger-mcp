/**
 * HttpRestClient с подменённым fetch: проверяется договор с сервером (заголовки, URL,
 * реакция на 401) и устойчивость разбора конверта KDC.
 */
import { describe, expect, it } from 'vitest';
import { AuthError } from '../../src/auth/AuthProvider.js';
import { HttpRestClient, RestError } from '../../src/transport/RestClient.js';
import { FakeAuth } from '../helpers/fakeAuth.js';
import { createTestConfig } from '../helpers/testConfig.js';

interface FetchCall {
  url: string;
  headers: Record<string, string>;
  method: string;
  /** Тело кадра как строка: у GET его нет вовсе, и это тоже утверждение о договоре */
  body?: string;
}

interface Harness {
  client: HttpRestClient;
  auth: FakeAuth;
  calls: FetchCall[];
  /** Запрошенные паузы: настоящая пауза по лимиту не бывает короче секунды по построению */
  pauses: number[];
}

/** Собирает клиент на очереди ответов: i-й вызов получает i-й ответ, последний повторяется */
function createHarness(responses: Array<() => Response>): Harness {
  const auth = new FakeAuth();
  const calls: FetchCall[] = [];
  const pauses: number[] = [];
  const config = createTestConfig();

  const fetchImplementation = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      method: init?.method ?? 'GET',
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (next === undefined) {
      throw new Error('тест не задал ответ fetch');
    }
    return next();
  }) as typeof fetch;

  return {
    auth,
    calls,
    pauses,
    client: new HttpRestClient({
      auth,
      config,
      fetchImplementation,
      sleepImplementation: async (ms: number) => {
        pauses.push(ms);
      },
    }),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('HttpRestClient.getJson', () => {
  it('шлёт bearer, cookie, Accept и User-Agent, склеивая URL из базы, пути и query', async () => {
    const harness = createHarness([() => jsonResponse({ ok: true })]);

    await harness.client.getJson('/v1/kdc/keys/', { ids: 'a,b' });

    const call = harness.calls[0];
    expect(call?.url).toBe('https://cts01.clouds.org.ru/api/v1/kdc/keys/?ids=a%2Cb');
    expect(call?.headers['Authorization']).toBe('Bearer bearer-1');
    expect(call?.headers['Cookie']).toBe('clouds_session=fake-session');
    expect(call?.headers['Accept']).toBe('application/json');
    expect(call?.headers['User-Agent']).toContain('Mozilla/5.0');
  });

  /* Bearer живёт недолго: 401 это штатное протухание, а не отказ в правах */
  it('на 401 сбрасывает кэш авторизации и повторяет ровно один раз с новым bearer', async () => {
    const harness = createHarness([
      () => jsonResponse({ error: 'unauthorized' }, 401),
      () => jsonResponse({ ok: true }),
    ]);

    const result = await harness.client.getJson<{ ok: boolean }>('/v1/whatever');

    expect(result).toEqual({ ok: true });
    expect(harness.auth.calls.onAuthFailure).toBe(1);
    expect(harness.calls).toHaveLength(2);
    expect(harness.calls[0]?.headers['Authorization']).toBe('Bearer bearer-1');
    expect(harness.calls[1]?.headers['Authorization']).toBe('Bearer bearer-2');
  });

  /* Второй 401 означает, что дело не в токене: повторять дальше значит молотить вход по кругу */
  it('второй 401 отдаёт AuthError и больше не повторяет', async () => {
    const harness = createHarness([() => jsonResponse({ error: 'unauthorized' }, 401)]);

    await expect(harness.client.getJson('/v1/whatever')).rejects.toMatchObject({
      name: 'AuthError',
      kind: 'bearer',
    });
    expect(harness.calls).toHaveLength(2);
    expect(harness.auth.calls.onAuthFailure).toBe(1);
  });

  it('прочий не-2xx отдаёт RestError со статусом, кодом из тела и срезом тела', async () => {
    const harness = createHarness([() => jsonResponse({ error: 'invalid_keys' }, 422)]);

    const error = await harness.client.getJson('/v1/whatever').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RestError);
    expect(error).toMatchObject({ status: 422, code: 'invalid_keys' });
    expect((error as RestError).bodySnippet).toContain('invalid_keys');
    expect(error).not.toBeInstanceOf(AuthError);
  });

  /* Тело отказа уезжает в сообщение ошибки и оттуда в логи: секретоподобные куски вырезаются */
  it('срез тела не тащит за собой секретоподобные последовательности', async () => {
    const secret = 'A'.repeat(120);
    const harness = createHarness([() => jsonResponse({ error: 'bad_token', token: secret }, 500)]);

    const error = (await harness.client.getJson('/v1/whatever').catch((caught: unknown) => caught)) as RestError;

    expect(error.bodySnippet).not.toContain(secret);
    expect(error.bodySnippet).toContain('redacted');
  });

  /*
   * 429 это не отказ, а просьба подождать. GET идемпотентен, поэтому просьба уважается
   * паузой и ровно одним повтором: молча вернуть ошибку значило бы разобрать просьбу
   * и выбросить, а повторять дальше значило бы дожимать исчерпанную квоту.
   */
  it('на 429 выдерживает паузу из Retry-After и повторяет ровно один раз', async () => {
    const harness = createHarness([
      () => new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429, headers: { 'Retry-After': '2' } }),
      () => jsonResponse({ ok: true }),
    ]);

    const result = await harness.client.getJson<{ ok: boolean }>('/v1/whatever');

    expect(result).toEqual({ ok: true });
    expect(harness.pauses).toEqual([2_000]);
    expect(harness.calls).toHaveLength(2);
    /* Лимит частоты это не протухший токен: вход не трогается */
    expect(harness.auth.calls.onAuthFailure).toBe(0);
  });

  it('на 429 без заголовка берёт retry_after из тела', async () => {
    const harness = createHarness([
      () => jsonResponse({ error: 'rate_limited', retry_after: 3_000 }, 429),
      () => jsonResponse({ ok: true }),
    ]);

    await expect(harness.client.getJson('/v1/whatever')).resolves.toEqual({ ok: true });
    expect(harness.pauses).toEqual([3_000]);
  });

  it('на 429 без всякой величины паузы всё равно ждёт, а не долбит сервер', async () => {
    const harness = createHarness([() => jsonResponse({ error: 'rate_limited' }, 429), () => jsonResponse({ ok: true })]);

    await expect(harness.client.getJson('/v1/whatever')).resolves.toEqual({ ok: true });
    expect(harness.pauses).toEqual([1_000]);
  });

  /* Повторная просьба означает исчерпанную квоту, а не паузу: дальше отказ уходит наверх */
  it('второй подряд 429 отдаёт RestError и больше не повторяет', async () => {
    const harness = createHarness([() => jsonResponse({ error: 'rate_limited' }, 429)]);

    const error = (await harness.client.getJson('/v1/whatever').catch((caught: unknown) => caught)) as RestError;

    expect(error).toBeInstanceOf(RestError);
    expect(error.status).toBe(429);
    expect(error.code).toBe('rate_limited');
    expect(harness.calls).toHaveLength(2);
    expect(harness.pauses).toHaveLength(1);
  });

  it('ответ не в JSON отдаёт RestError с диагнозом', async () => {
    const harness = createHarness([() => new Response('<html>не json</html>', { status: 200 })]);

    const error = (await harness.client.getJson('/v1/whatever').catch((caught: unknown) => caught)) as RestError;

    expect(error).toBeInstanceOf(RestError);
    expect(error.code).toBe('invalid_json');
  });
});

describe('HttpRestClient.postJson', () => {
  it('шлёт POST с телом в JSON, тем же bearer, cookie и типом содержимого', async () => {
    const harness = createHarness([() => jsonResponse({ status: 'ok' })]);

    await harness.client.postJson('/v1/phonebook/cts_profiles/query', { huids: ['a', 'b'] });

    const call = harness.calls[0];
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe('https://cts01.clouds.org.ru/api/v1/phonebook/cts_profiles/query');
    expect(call?.body).toBe(JSON.stringify({ huids: ['a', 'b'] }));
    expect(call?.headers['Content-Type']).toBe('application/json');
    expect(call?.headers['Authorization']).toBe('Bearer bearer-1');
    expect(call?.headers['Cookie']).toBe('clouds_session=fake-session');
    expect(call?.headers['User-Agent']).toContain('Mozilla/5.0');
  });

  /* Политика повторов у POST та же, что у GET: этот POST ничего на сервере не меняет */
  it('на 401 сбрасывает кэш авторизации и повторяет ровно один раз с новым bearer', async () => {
    const harness = createHarness([
      () => jsonResponse({ error: 'unauthorized' }, 401),
      () => jsonResponse({ status: 'ok' }),
    ]);

    await expect(harness.client.postJson('/v1/whatever', { huids: [] })).resolves.toEqual({
      status: 'ok',
    });
    expect(harness.auth.calls.onAuthFailure).toBe(1);
    expect(harness.calls).toHaveLength(2);
    expect(harness.calls[1]?.headers['Authorization']).toBe('Bearer bearer-2');
    expect(harness.calls[1]?.body).toBe(JSON.stringify({ huids: [] }));
  });

  it('на 429 выдерживает паузу из Retry-After и повторяет ровно один раз', async () => {
    const harness = createHarness([
      () =>
        new Response(JSON.stringify({ error: 'rate_limited' }), {
          status: 429,
          headers: { 'Retry-After': '2' },
        }),
      () => jsonResponse({ status: 'ok' }),
    ]);

    await expect(harness.client.postJson('/v1/whatever', {})).resolves.toEqual({ status: 'ok' });
    expect(harness.pauses).toEqual([2_000]);
    expect(harness.calls).toHaveLength(2);
    expect(harness.auth.calls.onAuthFailure).toBe(0);
  });

  it('прочий не-2xx отдаёт RestError со статусом и кодом из тела', async () => {
    const harness = createHarness([() => jsonResponse({ error: 'unexpected' }, 404)]);

    const error = (await harness.client
      .postJson('/v1/whatever', {})
      .catch((caught: unknown) => caught)) as RestError;

    expect(error).toBeInstanceOf(RestError);
    expect(error.status).toBe(404);
    expect(error.code).toBe('unexpected');
  });
});

describe('HttpRestClient.getKdcKeys', () => {
  const KEY_ROW = {
    key_id: '11111111-1111-5111-8111-111111111111',
    algo: 'xsalsa20:xchacha20_aead_ietf',
    kind: 'cts',
    body: 'cHVibGljLWtleS1ib2R5',
  };

  it('склеивает идентификаторы через запятую в query ids', async () => {
    const harness = createHarness([() => jsonResponse({ result: [KEY_ROW] })]);

    await harness.client.getKdcKeys([KEY_ROW.key_id, '22222222-2222-5222-8222-222222222222']);

    expect(harness.calls[0]?.url).toContain('ids=');
    expect(decodeURIComponent(harness.calls[0]?.url ?? '')).toContain(
      `ids=${KEY_ROW.key_id},22222222-2222-5222-8222-222222222222`,
    );
  });

  /* Три формы конверта наблюдались живьём: различать их по догадке нельзя */
  it('разбирает конверт result', async () => {
    const harness = createHarness([() => jsonResponse({ result: [KEY_ROW] })]);

    await expect(harness.client.getKdcKeys([KEY_ROW.key_id])).resolves.toEqual([KEY_ROW]);
  });

  it('разбирает конверт keys', async () => {
    const harness = createHarness([() => jsonResponse({ keys: [KEY_ROW] })]);

    await expect(harness.client.getKdcKeys([KEY_ROW.key_id])).resolves.toEqual([KEY_ROW]);
  });

  it('разбирает голый массив', async () => {
    const harness = createHarness([() => jsonResponse([KEY_ROW])]);

    await expect(harness.client.getKdcKeys([KEY_ROW.key_id])).resolves.toEqual([KEY_ROW]);
  });

  it('принимает id вместо key_id', async () => {
    const harness = createHarness([
      () => jsonResponse({ result: [{ id: KEY_ROW.key_id, algo: KEY_ROW.algo, kind: KEY_ROW.kind, body: KEY_ROW.body }] }),
    ]);

    await expect(harness.client.getKdcKeys([KEY_ROW.key_id])).resolves.toEqual([KEY_ROW]);
  });

  it('неожиданная форма конверта отдаёт RestError с диагнозом', async () => {
    const harness = createHarness([() => jsonResponse({ data: { keys: 'нет массива' } })]);

    const error = (await harness.client.getKdcKeys(['id']).catch((caught: unknown) => caught)) as RestError;

    expect(error).toBeInstanceOf(RestError);
    expect(error.code).toBe('unexpected_shape');
  });

  /* Неполный набор получателей это сообщение, которое часть участников не прочтёт */
  it('запись без body не пропускается молча, а роняет разбор', async () => {
    const harness = createHarness([() => jsonResponse({ result: [{ key_id: 'a', algo: 'x', kind: 'cts' }] })]);

    await expect(harness.client.getKdcKeys(['a'])).rejects.toBeInstanceOf(RestError);
  });

  it('пустой список идентификаторов не ходит в сеть', async () => {
    const harness = createHarness([() => jsonResponse({ result: [] })]);

    await expect(harness.client.getKdcKeys([])).resolves.toEqual([]);
    expect(harness.calls).toHaveLength(0);
  });
});
