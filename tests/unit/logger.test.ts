import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOG_LEVEL_ENV, REDACTED, createLogger, type LogLevel } from '../../src/util/logger.js';

/**
 * Синтетический секрет: 72 символа base64-алфавита. Живое значение здесь ничего не доказало бы,
 * зато осталось бы в исходниках, в истории и в любом форке.
 */
const SECRET_LIKE = 'ZXhhbXBsZS10b2tlbi1ib2R5LWZvci10ZXN0cy1vbmx5LW5vdC1hLXJlYWwtc2VjcmV0Lg==';
const FAKE_UUID = '00000000-0000-4000-8000-000000000000';

function capture(level: LogLevel = 'debug') {
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const logger = createLogger({ level });
  const entries = (): Array<Record<string, unknown>> =>
    stderr.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
  return { logger, stderr, stdout, entries };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('формат', () => {
  it('пишет одну JSON-строку в stderr и ни байта в stdout', () => {
    const { logger, stderr, stdout, entries } = capture();

    logger.info('ws connected', { requestNumber: 42 });

    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0]?.[0])).toMatch(/\n$/);

    const [entry] = entries();
    expect(entry?.['level']).toBe('info');
    expect(entry?.['msg']).toBe('ws connected');
    expect(entry?.['requestNumber']).toBe(42);
    expect(typeof entry?.['ts']).toBe('string');
  });
});

describe('уровень', () => {
  it('отсекает записи ниже установленного уровня', () => {
    const { logger, stderr, entries } = capture('warn');

    logger.debug('шум');
    logger.info('шум');
    logger.warn('осталось');

    expect(stderr).toHaveBeenCalledTimes(1);
    expect(entries()[0]?.['msg']).toBe('осталось');
  });

  it('берёт уровень из переменной окружения, по умолчанию info', () => {
    const previous = process.env[LOG_LEVEL_ENV];
    try {
      delete process.env[LOG_LEVEL_ENV];
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      createLogger().debug('ниже info');
      expect(stderr).not.toHaveBeenCalled();

      process.env[LOG_LEVEL_ENV] = 'debug';
      createLogger().debug('на debug видно');
      expect(stderr).toHaveBeenCalledTimes(1);
    } finally {
      if (previous === undefined) {
        delete process.env[LOG_LEVEL_ENV];
      } else {
        process.env[LOG_LEVEL_ENV] = previous;
      }
    }
  });
});

describe('редакция по именам полей', () => {
  it('вырезает значения секретов и содержимого переписки', () => {
    const { logger, entries } = capture();

    logger.info('отправка', {
      token: 'a',
      bearerToken: 'a',
      authorization: 'a',
      cookieHeader: 'a',
      sender_key_id: 'a',
      body: 'a',
      payload: 'a',
      signature: 'a',
      privateKeys: 'a',
      text: 'a',
      secretMaterial: 'a',
      password: 'a',
      syncId: FAKE_UUID,
    });

    const [entry] = entries();
    for (const field of [
      'token',
      'bearerToken',
      'authorization',
      'cookieHeader',
      'sender_key_id',
      'body',
      'payload',
      'signature',
      'privateKeys',
      'text',
      'secretMaterial',
      'password',
    ]) {
      expect(entry?.[field]).toBe(REDACTED);
    }
    /* Несекретная диагностика остаётся читаемой, иначе лог бесполезен */
    expect(entry?.['syncId']).toBe(FAKE_UUID);
  });
});

describe('исключения словаря редакции', () => {
  it('context остаётся читаемым, а text_preview и plaintext вырезаются', () => {
    const { logger, entries } = capture();

    logger.debug('вызов инструмента', {
      context: 'get_history',
      component: 'ws',
      text_preview: 'первые слова чужого сообщения',
      plaintext: 'расшифрованное тело',
    });

    const [entry] = entries();
    /* Слово text сидит внутри context подстрокой, но переписки в нём нет */
    expect(entry?.['context']).toBe('get_history');
    expect(entry?.['component']).toBe('ws');
    expect(entry?.['text_preview']).toBe(REDACTED);
    expect(entry?.['plaintext']).toBe(REDACTED);
  });
});

describe('редакция по подстроке значения', () => {
  it('глушит секретоподобную последовательность даже под безобидным именем поля', () => {
    const { logger, entries } = capture();

    logger.info('отказ', { note: SECRET_LIKE, шум: 'короткая диагностика' });

    const [entry] = entries();
    expect(entry?.['note']).toBe(`<redacted:${SECRET_LIKE.length}>`);
    expect(entry?.['шум']).toBe('короткая диагностика');
    expect(JSON.stringify(entry)).not.toContain(SECRET_LIKE);
  });

  it('глушит секрет внутри текста ошибки', () => {
    const { logger, entries } = capture();

    logger.error('запрос не прошёл', { failure: new Error(SECRET_LIKE) });

    expect(JSON.stringify(entries()[0])).not.toContain(SECRET_LIKE);
  });
});

describe('вложенность', () => {
  it('редактирует внутри объектов и массивов', () => {
    const { logger, entries } = capture();

    logger.debug('кадр', {
      frame: {
        topic: 'system',
        event: { payload: 'приватное', note: SECRET_LIKE },
        keys: [{ key_id: FAKE_UUID, key: 'приватное' }],
        list: ['короткая', SECRET_LIKE],
      },
    });

    const serialized = JSON.stringify(entries()[0]);
    expect(serialized).not.toContain('приватное');
    expect(serialized).not.toContain(SECRET_LIKE);
    /* Структура кадра остаётся видимой: без неё нечего расследовать */
    expect(serialized).toContain('system');
    expect(serialized).toContain('короткая');
  });
});

describe('bindings и child', () => {
  it('child наследует и дополняет bindings', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const logger = createLogger({ level: 'debug', bindings: { component: 'ws' } });

    logger.child({ topic: 'system' }).info('открыт');

    const entry = JSON.parse(String(stderr.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(entry['component']).toBe('ws');
    expect(entry['topic']).toBe('system');
  });
});

/**
 * Класс I матрицы инвариантов (AC-9). Проверяется не «поле называется правильно», а факт:
 * ни один символ чужого текста и ни один секрет не выходит наружу. Отсюда проверки по
 * подстроке в перехваченном stderr, а не по значению конкретного поля: поле легко
 * переименовать, а обещание приватности от этого не меняется.
 */
describe('класс I: приватность', () => {
  /** Текст «переписки» для проверок: ни одного его символа не должно остаться в логе */
  const MESSAGE_TEXT = 'встречаемся у второго подъезда в девять';
  const FAKE_HUID = '11111111-1111-5111-8111-111111111111';

  it('расшифрованное событие не проходит в лог ни одним символом текста', () => {
    const { logger, stderr } = capture();

    logger.debug('событие расшифровано', {
      event: {
        type: 'text',
        body: MESSAGE_TEXT,
        from: FAKE_HUID,
        preview: MESSAGE_TEXT,
        file_name: 'договор.pdf',
        payload: { text: MESSAGE_TEXT, encrypted: MESSAGE_TEXT },
      },
    });

    const written = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(written).not.toContain(MESSAGE_TEXT);
    expect(written).not.toContain('договор.pdf');
    /* Форма события остаётся видимой: без неё расследовать нечего */
    expect(written).toContain('text');
    expect(written).toContain(FAKE_HUID);
  });

  it('редактирует секретные поля на любой глубине и внутри массивов', () => {
    const { logger, stderr } = capture();

    logger.info('кадр', {
      outer: {
        token: 'приватное',
        bearer: 'приватное',
        cookie: 'приватное',
        authorization: 'приватное',
        inner: {
          key: 'приватное',
          sign: 'приватное',
          payload: 'приватное',
          private: 'приватное',
          secret: 'приватное',
          password: 'приватное',
        },
        recipients: [{ key: 'приватное' }, { token: 'приватное' }],
      },
    });

    expect(String(stderr.mock.calls[0]?.[0])).not.toContain('приватное');
  });

  it('глушит bearer-подобную вставку в строке под нейтральным именем поля', () => {
    const { logger, entries } = capture();

    logger.warn('отказ сервера', { note: `сервер ответил: Bearer ${SECRET_LIKE} и закрыл сокет` });

    const [entry] = entries();
    expect(String(entry?.['note'])).toMatch(/^<redacted:\d+>$/);
    expect(JSON.stringify(entry)).not.toContain(SECRET_LIKE);
  });

  it('чистит и само сообщение записи, а не только поля', () => {
    const { logger, entries } = capture();

    logger.error(`запрос отклонён с токеном ${SECRET_LIKE}`);

    const [entry] = entries();
    expect(String(entry?.['msg'])).toMatch(/^<redacted:\d+>$/);
    expect(JSON.stringify(entry)).not.toContain(SECRET_LIKE);
  });

  /* Редакция не имеет права съедать диагностику: иначе её отключат первой же правкой */
  it('не трогает числа, булевы, null и короткие идентификаторы', () => {
    const { logger, entries } = capture();

    logger.debug('диагностика', {
      attempt: 3,
      delayMs: 0,
      retryAllowed: false,
      dropped: true,
      reason: null,
      syncId: FAKE_UUID,
      event: 'app_event',
    });

    const [entry] = entries();
    expect(entry?.['attempt']).toBe(3);
    expect(entry?.['delayMs']).toBe(0);
    expect(entry?.['retryAllowed']).toBe(false);
    expect(entry?.['dropped']).toBe(true);
    expect(entry?.['reason']).toBeNull();
    expect(entry?.['syncId']).toBe(FAKE_UUID);
    expect(entry?.['event']).toBe('app_event');
  });
});
