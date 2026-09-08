/**
 * База ошибок: тег слоя обязателен, неизвестный код не проглатывается, исходный текст
 * не теряется ни у одного класса отказа.
 *
 * Требования проверяются текстом сообщения, а не только полями, потому что наружу, в MCP,
 * уезжает именно текст: агент читает его и по нему решает, что чинить.
 */
import { describe, expect, it } from 'vitest';
import { AuthError } from '../../src/auth/AuthProvider.js';
import { KeyNotFoundError } from '../../src/auth/keyStore.js';
import { DecryptError } from '../../src/crypto/decrypt.js';
import { KeyResolutionError } from '../../src/crypto/keys.js';
import {
  MessengerError,
  describeError,
  toMessengerError,
  type ErrorLayer,
} from '../../src/protocol/errors.js';
import { RateLimitError, RestError } from '../../src/transport/RestClient.js';
import {
  PhoenixReplyError,
  WsClosedError,
  WsTimeoutError,
} from '../../src/transport/ws/PhoenixClient.js';

const CHAT_TOPIC = 'groupchat:11111111-2222-4333-8444-555555555555';
const SEND_EVENT = 'message_new';

/** Все наблюдаемые классы отказа разом: слой, код и сохранность исходного текста */
const SAMPLES: Array<{ error: Error; layer: ErrorLayer; code: string }> = [
  {
    error: new PhoenixReplyError('invalid_keys', CHAT_TOPIC, SEND_EVENT, {}),
    layer: 'phoenix',
    code: 'invalid_keys',
  },
  {
    error: new PhoenixReplyError('quantum_flux', CHAT_TOPIC, SEND_EVENT, {}),
    layer: 'phoenix',
    code: 'quantum_flux',
  },
  { error: new WsClosedError('сервер разорвал соединение'), layer: 'phoenix', code: 'transport_closed' },
  {
    error: new WsTimeoutError('system', 'event_info', 30_000),
    layer: 'phoenix',
    code: 'transport_timeout',
  },
  { error: new RestError(500, undefined, 'internal error'), layer: 'rest', code: '500' },
  {
    error: new RestError(400, 'unexpected_shape', 'запись KDC 0 без key_id'),
    layer: 'rest',
    code: 'unexpected_shape',
  },
  { error: new RateLimitError(2_000, undefined, 'slow down'), layer: 'rest', code: 'rate_limited' },
  {
    error: new DecryptError('wrap', 'key-id', 'chat-id', 'sync-id', 'подложная причина'),
    layer: 'client',
    code: 'decrypt_wrap',
  },
  {
    error: new DecryptError('body', 'key-id', 'chat-id', 'sync-id', 'подложная причина'),
    layer: 'client',
    code: 'decrypt_body',
  },
  {
    error: new DecryptError('json', 'key-id', 'chat-id', 'sync-id', 'подложная причина'),
    layer: 'client',
    code: 'decrypt_json',
  },
  { error: new KeyNotFoundError('key-id', ['known-key-id']), layer: 'client', code: 'key_not_found' },
  {
    error: new KeyResolutionError(['missing'], ['missing', 'present']),
    layer: 'client',
    code: 'key_resolution',
  },
  { error: new AuthError('сессия отвергнута', 'bearer'), layer: 'client', code: 'auth_bearer' },
  { error: new AuthError('authenticate без ответа', 'protocol'), layer: 'client', code: 'auth_protocol' },
  { error: new Error('что-то пошло не так'), layer: 'client', code: 'unexpected' },
];

describe('MessengerError', () => {
  it('известный код Phoenix несёт тег слоя, имя кода и человеческое пояснение', () => {
    const error = new MessengerError({ layer: 'phoenix', code: 'invalid_keys' });

    expect(error.message.startsWith('[phoenix] invalid_keys: ')).toBe(true);
    expect(error.known).toBe(true);
    expect(error.detail.length).toBeGreaterThan(0);
  });

  it('неизвестный код объявляется неизвестным, но доезжает наружу как есть', () => {
    const error = new MessengerError({
      layer: 'phoenix',
      code: 'quantum_flux',
      detail: 'топик system, событие event_info',
    });

    expect(error.message).toBe('[phoenix] unknown code: quantum_flux: топик system, событие event_info');
    expect(error.code).toBe('quantum_flux');
    expect(error.known).toBe(false);
  });

  it('пустая подробность не превращается в оборванный текст', () => {
    expect(new MessengerError({ layer: 'client', code: 'unexpected' }).message).toBe(
      '[client] unexpected: без подробностей',
    );
  });

  it('каждый объявленный код Phoenix несёт пояснение, а не одно имя', () => {
    for (const code of [
      'invalid_keys',
      'unauthorized',
      'not_found',
      'forbidden',
      'timeout',
      'rate_limited',
      'too_many_requests',
      'transport_closed',
      'transport_timeout',
    ]) {
      const error = new MessengerError({ layer: 'phoenix', code });

      expect(error.known).toBe(true);
      expect(error.detail).not.toBe('без подробностей');
    }
  });
});

describe('describeError по классам отказа', () => {
  it('каждый класс получает свой слой, свой код и не теряет исходного текста', () => {
    for (const sample of SAMPLES) {
      const described = describeError(sample.error);

      expect(described.layer).toBe(sample.layer);
      expect(described.code).toBe(sample.code);
      expect(described.message).toContain(`[${sample.layer}]`);
      expect(described.message).toContain(sample.code);
      expect(described.message).toContain(sample.error.message);
    }
  });

  it('отказ phx_reply оставляет в подробности топик и событие', () => {
    const described = describeError(new PhoenixReplyError('invalid_keys', CHAT_TOPIC, SEND_EVENT, {}));

    expect(described.message).toContain('[phoenix] invalid_keys:');
    expect(described.detail).toContain(CHAT_TOPIC);
    expect(described.detail).toContain(SEND_EVENT);
    expect(described.known).toBe(true);
  });

  it('незнакомый код сервера объявляется неизвестным, а не сводится к своему словарю', () => {
    const described = describeError(new PhoenixReplyError('quantum_flux', CHAT_TOPIC, SEND_EVENT, {}));

    expect(described.known).toBe(false);
    expect(described.message.startsWith('[phoenix] unknown code: quantum_flux: ')).toBe(true);
  });

  it('обрыв и молчание сокета это слой phoenix со своими кодами', () => {
    expect(describeError(new WsClosedError('сервер разорвал соединение')).known).toBe(true);
    expect(describeError(new WsTimeoutError('system', 'event_info', 30_000)).detail).toContain(
      'event_info',
    );
  });

  it('отказ REST это слой rest, код тела старше номера статуса', () => {
    expect(describeError(new RestError(404, undefined, 'not found')).code).toBe('404');

    const withBodyCode = describeError(new RestError(400, 'unexpected_shape', 'запись KDC 0 без key_id'));
    expect(withBodyCode.message).toContain('[rest] unexpected_shape:');
    expect(withBodyCode.message).toContain('HTTP 400');
  });

  it('просьба подождать несёт величину паузы: без неё её пришлось бы разбирать заново', () => {
    const described = describeError(new RateLimitError(2_000, undefined, 'slow down'));

    expect(described.layer).toBe('rest');
    expect(described.code).toBe('rate_limited');
    expect(described.detail).toContain('2000');
  });

  it('шаг расшифровки виден в коде: причины у обёртки и у тела разные', () => {
    const wrap = describeError(new DecryptError('wrap', 'key-id', 'chat-id', 'sync-id', 'причина'));
    const body = describeError(new DecryptError('body', 'key-id', 'chat-id', 'sync-id', 'причина'));

    expect(wrap.code).not.toBe(body.code);
    expect(wrap.message.startsWith('[client] decrypt_wrap: ')).toBe(true);
  });

  it('вид отказа авторизации виден в коде: bearer лечится не тем же, что протокол', () => {
    expect(describeError(new AuthError('сессия отвергнута', 'bearer')).code).toBe('auth_bearer');
    expect(describeError(new AuthError('без ответа', 'protocol')).code).toBe('auth_protocol');
  });

  it('любая посторонняя ошибка это client unexpected, а текст не теряется', () => {
    const described = describeError(new Error('что-то пошло не так'));

    expect(described.message).toBe('[client] unexpected: что-то пошло не так');
  });

  it('не-ошибка тоже доезжает текстом, а не пропадает', () => {
    expect(describeError('строка вместо ошибки').message).toBe(
      '[client] unexpected: строка вместо ошибки',
    );
  });

  it('уже разобранная ошибка не получает второго тега', () => {
    const once = describeError(new PhoenixReplyError('unauthorized', 'system', 'event_info', {}));
    expect(describeError(once)).toBe(once);
  });
});

describe('toMessengerError', () => {
  it('приводит к той же форме, что видит сервер при сборке ответа', () => {
    for (const sample of SAMPLES) {
      const converted = toMessengerError(sample.error);

      expect(converted).toBeInstanceOf(MessengerError);
      expect(converted.message).toBe(describeError(sample.error).message);
    }
  });
});
