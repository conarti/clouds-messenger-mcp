/**
 * Кодек кадров Phoenix.
 *
 * Фикстуры формы вписаны в тест, а не читаются из артефактов пробы: артефакты Фазы 0
 * лежат вне репозитория (каталог исследований не коммитится) и содержат живые тела
 * сообщений. Сюда перенесены ТОЛЬКО имена полей и статусы, значения заменены.
 */
import { describe, expect, it } from 'vitest';
import {
  decodeFrame,
  encodeFrame,
  isReply,
  parseReply,
  REPLY_EVENT,
  type PhoenixFrame,
} from '../../src/transport/ws/frames.js';

/** Форма ответа: снято с p0-ws-structure.json, раздел replies */
const REPLY_FRAME = {
  topic: 'phoenix',
  event: REPLY_EVENT,
  ref: 0,
  payload: { status: 'ok', response: {} },
};

/** Форма кадра сервера: снято с p0-ws-structure.json, раздел server_initiated */
const SERVER_EVENT_FRAME = {
  topic: 'system',
  event: 'app_event',
  payload: {
    version: 1,
    key: { key: 'AAA', key_id: 'key-id', algo: 'xsalsa20:xchacha20_aead_ietf' },
    sender: 'sender-huid',
    inserted_at: '2026-09-08T00:00:00Z',
    sync_id: 'sync-id',
    payload: { meta: {}, event: 'AAA' },
  },
};

/** Форма кадра отправки: снято с p1-send-frame.json, значения заменены */
const MESSAGE_NEW_PAYLOAD_FIELDS = ['keys', 'group_chat_id', 'sync_id', 'payload', 'signature'];
const MESSAGE_NEW_KEY_FIELDS = ['key_id', 'key', 'algo'];
const MESSAGE_NEW_SIGNATURE_FIELDS = ['sign', 'sign_key_id', 'sign_algo'];

describe('encodeFrame', () => {
  it('даёт JSON ровно с четырьмя полями кадра', () => {
    const frame: PhoenixFrame = {
      topic: 'system',
      event: 'get_chat_list_base_changes',
      payload: { since: '1970-01-01T00:00:00.000000Z', request_version: 6 },
      ref: 10,
    };

    const parsed = JSON.parse(encodeFrame(frame)) as Record<string, unknown>;

    expect(Object.keys(parsed).sort()).toEqual(['event', 'payload', 'ref', 'topic']);
    expect(parsed).toEqual({
      topic: 'system',
      event: 'get_chat_list_base_changes',
      payload: { since: '1970-01-01T00:00:00.000000Z', request_version: 6 },
      ref: 10,
    });
  });

  it('кадр сервера кодируется с ref null, а не с пропущенным полем', () => {
    const parsed = JSON.parse(
      encodeFrame({ topic: 'system', event: 'app_event', payload: {}, ref: null }),
    ) as Record<string, unknown>;

    expect(parsed['ref']).toBeNull();
    expect('ref' in parsed).toBe(true);
  });

  /* Кадр отправки собирается вызывающим, но именно кодек обязан донести его форму без потерь */
  it('сохраняет множество имён полей кадра message_new', () => {
    const frame: PhoenixFrame = {
      topic: 'groupchat:group-id',
      event: 'message_new',
      payload: {
        keys: [{ key_id: 'recipient-key-id', key: 'wrapped', algo: 'xsalsa20:xchacha20_aead_ietf' }],
        group_chat_id: 'group-id',
        sync_id: 'sync-id',
        payload: 'ciphertext',
        signature: { sign: 'signature', sign_key_id: 'sign-key-id', sign_algo: 'ed25519' },
      },
      ref: 34,
    };

    const parsed = JSON.parse(encodeFrame(frame)) as {
      payload: {
        keys: Array<Record<string, unknown>>;
        signature: Record<string, unknown>;
      };
    };

    expect(Object.keys(parsed.payload).sort()).toEqual([...MESSAGE_NEW_PAYLOAD_FIELDS].sort());
    expect(Object.keys(parsed.payload.keys[0] ?? {}).sort()).toEqual([...MESSAGE_NEW_KEY_FIELDS].sort());
    expect(Object.keys(parsed.payload.signature).sort()).toEqual([...MESSAGE_NEW_SIGNATURE_FIELDS].sort());
  });
});

describe('decodeFrame', () => {
  it('разбирает ответ формы p0-ws-structure', () => {
    const decoded = decodeFrame(JSON.stringify(REPLY_FRAME));

    expect(decoded.ok).toBe(true);
    if (!decoded.ok) {
      return;
    }
    expect(decoded.frame.topic).toBe('phoenix');
    expect(decoded.frame.ref).toBe(0);
    expect(isReply(decoded.frame)).toBe(true);
  });

  it('разбирает кадр сервера: ref null и это не ответ', () => {
    const decoded = decodeFrame(JSON.stringify(SERVER_EVENT_FRAME));

    expect(decoded.ok).toBe(true);
    if (!decoded.ok) {
      return;
    }
    expect(decoded.frame.ref).toBeNull();
    expect(isReply(decoded.frame)).toBe(false);
    expect(decoded.frame.event).toBe('app_event');
  });

  /* Сокет это внешний мир: мусор обязан вернуть диагноз, а не исключение посреди обработки */
  it('не-JSON отбрасывается с диагнозом', () => {
    const decoded = decodeFrame('не json');

    expect(decoded.ok).toBe(false);
    if (decoded.ok) {
      return;
    }
    expect(decoded.reason).toContain('не является JSON');
  });

  it('не-объект отбрасывается с диагнозом', () => {
    for (const raw of ['42', '"строка"', 'null', '[1,2]']) {
      const decoded = decodeFrame(raw);

      expect(decoded.ok).toBe(false);
      if (decoded.ok) {
        continue;
      }
      expect(decoded.reason).toContain('не является объектом');
    }
  });

  it('объект без topic или event отбрасывается с диагнозом', () => {
    const withoutTopic = decodeFrame(JSON.stringify({ event: 'phx_reply', ref: 1 }));
    const withoutEvent = decodeFrame(JSON.stringify({ topic: 'system', ref: 1 }));

    expect(withoutTopic.ok).toBe(false);
    expect(withoutEvent.ok).toBe(false);
    if (!withoutTopic.ok) {
      expect(withoutTopic.reason).toContain('topic');
    }
    if (!withoutEvent.ok) {
      expect(withoutEvent.reason).toContain('event');
    }
  });

  it('нечисловой ref приравнивается к отсутствию: корреляция идёт только по числу', () => {
    const decoded = decodeFrame(JSON.stringify({ topic: 'system', event: 'app_event', ref: '7' }));

    expect(decoded.ok).toBe(true);
    if (!decoded.ok) {
      return;
    }
    expect(decoded.frame.ref).toBeNull();
  });
});

describe('parseReply', () => {
  it('успех отдаёт response', () => {
    const frame: PhoenixFrame = {
      topic: 'groupchat:group-id',
      event: REPLY_EVENT,
      payload: { status: 'ok', response: { inserted_at: '2026-09-08T00:00:00Z' } },
      ref: 34,
    };

    expect(parseReply(frame)).toEqual({
      status: 'ok',
      response: { inserted_at: '2026-09-08T00:00:00Z' },
    });
  });

  /* Наблюдённый живьём отказ: {status:"error", response:{error:"invalid_keys"}} */
  it('отказ отдаёт строковый код из response.error', () => {
    const frame: PhoenixFrame = {
      topic: 'groupchat:group-id',
      event: REPLY_EVENT,
      payload: { status: 'error', response: { error: 'invalid_keys' } },
      ref: 34,
    };

    expect(parseReply(frame)).toEqual({
      status: 'error',
      response: { error: 'invalid_keys' },
      errorCode: 'invalid_keys',
    });
  });

  it('незнакомый статус считается отказом, а не пустым успехом', () => {
    const frame: PhoenixFrame = {
      topic: 'system',
      event: REPLY_EVENT,
      payload: { status: 'timeout', response: null },
      ref: 1,
    };

    expect(parseReply(frame).status).toBe('error');
  });

  it('payload не объект тоже считается отказом', () => {
    const frame: PhoenixFrame = { topic: 'system', event: REPLY_EVENT, payload: 'мусор', ref: 1 };

    expect(parseReply(frame).status).toBe('error');
    expect(parseReply(frame).errorCode).toBeUndefined();
  });
});
