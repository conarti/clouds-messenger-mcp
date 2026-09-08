/**
 * Подтверждение необратимой отправки: отпечаток нагрузки, словарь отказов и память
 * результата.
 *
 * КЛАСС A (атакующие пары). Отпечаток считается по ДОСЛОВНО выписанной строке, и вся его
 * ценность в том, что разные намерения дают разные значения. Поэтому здесь не «хэш
 * стабилен», а набор пар, каждая из которых при неаккуратной сериализации схлопнулась бы
 * в одно значение: тот же текст в другой чат, другой текст в тот же чат, перестановка
 * значений полей, текст с переводами строк и двоеточиями.
 *
 * КЛАСС G (идемпотентность). Серверный дедуп по повторному идентификатору отправки живой
 * пробой НЕ проверялся, поэтому повтор закрывается локальной памятью результата, и её
 * границы проверяются здесь же.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CONFIRM_MEMORY_LIMIT,
  ConfirmMemory,
  ConfirmRejectedError,
  decodeToken,
  encodeToken,
  fingerprint,
  verifyConfirm,
  type DraftToken,
} from '../../src/mcp/confirm.js';
import { buildSendPayload, sendFingerprint } from '../../src/mcp/tools/sendMessage.js';

const CHAT = '11111111-2222-4333-8444-555555555555';
const OTHER_CHAT = '25c467fc-ad3d-5524-8455-4613a346d0cc';
const SYNC_ID = '00000000-0000-4000-8000-000000000001';

function makeToken(overrides: Partial<DraftToken> = {}): DraftToken {
  return {
    op: 'send',
    chat_id: CHAT,
    fingerprint: sendFingerprint(CHAT, 'привет'),
    sync_id: SYNC_ID,
    ...overrides,
  };
}

/** Токен с произвольным содержимым: так собирается предъявление токена чужой операции */
function encodeRaw(fields: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(fields), 'utf8').toString('base64url');
}

function rejectionOf(call: () => unknown): ConfirmRejectedError {
  try {
    call();
  } catch (error) {
    if (error instanceof ConfirmRejectedError) {
      return error;
    }
    throw error;
  }
  throw new Error('ожидался отказ подтверждения');
}

describe('упаковка токена', () => {
  it('разбор возвращает ровно то, что упаковано', () => {
    const token = makeToken();

    expect(decodeToken(encodeToken(token))).toEqual(token);
  });

  it('мусор и неполный набор полей дают undefined, а не исключение', () => {
    expect(decodeToken('это не base64url и не json')).toBeUndefined();
    expect(decodeToken(encodeRaw({ chat_id: CHAT }))).toBeUndefined();
    expect(decodeToken(encodeRaw({ op: 'send', chat_id: CHAT, fingerprint: 'f' }))).toBeUndefined();
    expect(
      decodeToken(encodeRaw({ op: 'send', chat_id: CHAT, fingerprint: 'f', sync_id: 42 })),
    ).toBeUndefined();
  });

  it('токен чужой операции разбирается: его судьбу решает сверка, а не кодек', () => {
    const decoded = decodeToken(encodeRaw({ ...makeToken(), op: 'delete' }));

    expect(decoded?.op).toBe('delete');
  });
});

describe('отпечаток нагрузки', () => {
  it('считается ровно как sha256 от операции, двоеточия и нагрузки', () => {
    const payload = buildSendPayload(CHAT, 'привет');
    const expected = createHash('sha256').update(`send:${payload}`, 'utf8').digest('hex');

    expect(fingerprint('send', payload)).toBe(expected);
    expect(sendFingerprint(CHAT, 'привет')).toBe(expected);
  });

  it('одна и та же пара чата и текста даёт одно значение', () => {
    expect(sendFingerprint(CHAT, 'привет')).toBe(sendFingerprint(CHAT, 'привет'));
  });

  it('тот же текст в другой чат это другой отпечаток', () => {
    expect(sendFingerprint(CHAT, 'привет')).not.toBe(sendFingerprint(OTHER_CHAT, 'привет'));
  });

  it('другой текст в тот же чат это другой отпечаток', () => {
    expect(sendFingerprint(CHAT, 'привет')).not.toBe(sendFingerprint(CHAT, 'привет!'));
  });

  it('перестановка значений полей меняет отпечаток', () => {
    expect(sendFingerprint(CHAT, OTHER_CHAT)).not.toBe(sendFingerprint(OTHER_CHAT, CHAT));
  });

  it('атакующие пары с переводами строк и двоеточиями не схлопываются в одно значение', () => {
    /*
     * Каждая пара подобрана так, чтобы при склейке полей без разделителя либо при
     * схлопывании пустых частей два разных намерения дали одно значение.
     */
    const variants: Array<{ chat: string; text: string }> = [
      { chat: CHAT, text: 'первая строка\nвторая строка' },
      { chat: CHAT, text: 'первая строка\n\nвторая строка' },
      { chat: CHAT, text: 'первая строка' },
      { chat: CHAT, text: '\nпервая строка\nвторая строка' },
      { chat: CHAT, text: `${OTHER_CHAT}\nпервая строка` },
      { chat: OTHER_CHAT, text: 'первая строка' },
      { chat: CHAT, text: 'send:первая строка' },
      { chat: CHAT, text: ':первая строка' },
      { chat: CHAT, text: 'первая строка:' },
      { chat: CHAT, text: `send:${CHAT}\nпервая строка` },
    ];

    const fingerprints = variants.map((variant) => sendFingerprint(variant.chat, variant.text));

    expect(new Set(fingerprints).size).toBe(variants.length);
  });
});

describe('перепроверка подтверждения', () => {
  it('совпадение операции, чата и отпечатка возвращает разобранный токен', () => {
    const token = makeToken();

    const verified = verifyConfirm({
      op: 'send',
      token: encodeToken(token),
      chatId: CHAT,
      fingerprint: sendFingerprint(CHAT, 'привет'),
    });

    expect(verified).toEqual(token);
  });

  it('токена нет либо он пуст: missing_token', () => {
    const absent = rejectionOf(() =>
      verifyConfirm({ op: 'send', token: undefined, chatId: CHAT, fingerprint: 'f' }),
    );
    const empty = rejectionOf(() =>
      verifyConfirm({ op: 'send', token: '', chatId: CHAT, fingerprint: 'f' }),
    );

    expect(absent.reason).toBe('missing_token');
    expect(empty.reason).toBe('missing_token');
  });

  it('токен не разобран: malformed_token', () => {
    const rejected = rejectionOf(() =>
      verifyConfirm({ op: 'send', token: 'обрезанный кусок', chatId: CHAT, fingerprint: 'f' }),
    );

    expect(rejected.reason).toBe('malformed_token');
  });

  it('токен чужой операции: op_mismatch, и он старше сверки чата', () => {
    /* И операция, и чат расходятся: причина обязана назвать операцию, а не чат */
    const token = encodeRaw({ ...makeToken({ chat_id: OTHER_CHAT }), op: 'delete' });

    const rejected = rejectionOf(() =>
      verifyConfirm({
        op: 'send',
        token,
        chatId: CHAT,
        fingerprint: sendFingerprint(CHAT, 'привет'),
      }),
    );

    expect(rejected.reason).toBe('op_mismatch');
  });

  it('запрос резолвится в другой чат: chat_mismatch', () => {
    const rejected = rejectionOf(() =>
      verifyConfirm({
        op: 'send',
        token: encodeToken(makeToken()),
        chatId: OTHER_CHAT,
        fingerprint: sendFingerprint(CHAT, 'привет'),
      }),
    );

    expect(rejected.reason).toBe('chat_mismatch');
  });

  it('текст изменился: fingerprint_mismatch', () => {
    const rejected = rejectionOf(() =>
      verifyConfirm({
        op: 'send',
        token: encodeToken(makeToken()),
        chatId: CHAT,
        fingerprint: sendFingerprint(CHAT, 'привет!'),
      }),
    );

    expect(rejected.reason).toBe('fingerprint_mismatch');
  });
});

describe('память результата подтверждения', () => {
  it('запомненный результат отдаётся по тому же токену, чужой токен ничего не даёт', () => {
    const memory = new ConfirmMemory();
    const result = { status: 'sent', message_id: SYNC_ID };

    memory.remember('токен', result);

    expect(memory.recall('токен')).toEqual(result);
    expect(memory.recall('другой токен')).toBeUndefined();
  });

  it('память ограничена сверху и вытесняет старейшее', () => {
    const memory = new ConfirmMemory(3);

    memory.remember('первый', 1);
    memory.remember('второй', 2);
    memory.remember('третий', 3);
    memory.remember('четвёртый', 4);

    expect(memory.size).toBe(3);
    expect(memory.recall('первый')).toBeUndefined();
    expect(memory.recall('четвёртый')).toBe(4);
  });

  it('потолок по умолчанию соблюдается тем же правилом вытеснения', () => {
    const memory = new ConfirmMemory();
    for (let index = 0; index <= CONFIRM_MEMORY_LIMIT; index += 1) {
      memory.remember(`токен-${index}`, index);
    }

    expect(memory.size).toBe(CONFIRM_MEMORY_LIMIT);
    expect(memory.recall('токен-0')).toBeUndefined();
    expect(memory.recall(`токен-${CONFIRM_MEMORY_LIMIT}`)).toBe(CONFIRM_MEMORY_LIMIT);
  });

  it('сброс очищает память целиком', () => {
    const memory = new ConfirmMemory();
    memory.remember('токен', 1);

    memory.clear();

    expect(memory.recall('токен')).toBeUndefined();
    expect(memory.size).toBe(0);
  });
});
