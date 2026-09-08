import { describe, expect, it } from 'vitest';
import { createRequestId } from '../../src/transport/requestId.js';

/*
 * `sync_id` отвечает за идемпотентность отправки: совпадение двух значений означало бы,
 * что сервер посчитает разные сообщения одним. Поэтому тест проверяет и форму, и то, что
 * значения не повторяются.
 */
describe('createRequestId', () => {
  it('даёт канонический UUID v4 в нижнем регистре', () => {
    const id = createRequestId();

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id).toHaveLength(36);
  });

  it('не повторяется', () => {
    const ids = new Set(Array.from({ length: 1_000 }, createRequestId));

    expect(ids.size).toBe(1_000);
  });
});
