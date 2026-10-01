/**
 * `send_message` от вызова MCP до кадра на проводе.
 *
 * Настоящими здесь являются все слои, кроме двух подмен: адрес сокета ведёт в локальный
 * Phoenix-мок, а KDC отвечает подложным fetch. Клиент сокета, libsodium, сборка кадра и
 * регистрация инструмента боевые, поэтому отправленный кадр можно расшифровать фикстурными
 * ключами получателя и увидеть исходный текст.
 *
 * Один вызов отправляет ровно один кадр, а неразрешённый адресат не отправляет НИЧЕГО.
 * Считаются кадры по ВСЕМ соединениям, а не по последнему: взгляд только на текущее
 * соединение спрятал бы отправку, случившуюся до переподключения.
 *
 * Повтор вызова шлёт второй кадр, и это заявленное поведение: серверный дедуп по
 * повторному идентификатору отправки живой пробой НЕ проверялся.
 */
import sodium from 'libsodium-wrappers-sumo';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SendMessageResult } from '../../src/mcp/tools/sendMessage.js';
import { MESSAGE_NEW_EVENT } from '../../src/protocol/mutations.js';
import { makeKeyRing, type KeyRing } from '../helpers/cryptoFixtures.js';
import { OTHER_CHAT_ID, POLYGON_CHAT_ID, makeRawChat } from '../helpers/readFixtures.js';
import { startToolServer, type ToolServer } from '../helpers/toolServer.js';

const INSERTED_AT = '2026-09-08T07:10:00.000Z';
const TEXT = 'привет из проверки';
const NONCE_BYTES = 24;

/** Кадр отправки, как он приезжает на мок */
interface SentPayload {
  keys: Array<{ key_id: string; key: string; algo: string }>;
  group_chat_id: string;
  sync_id: string;
  payload: string;
  signature: { sign: string; sign_key_id: string; sign_algo: string };
}

let ring: KeyRing;
let server: ToolServer;
/** Переключатель подложного сервера: им проверяется путь прикладного отказа */
let sendRejects: boolean;

function chats(): Record<string, unknown>[] {
  return [
    makeRawChat({
      chatId: POLYGON_CHAT_ID,
      name: 'Избранное',
      chatType: 'notes',
      updatedAt: '2026-09-08T07:05:00.000000Z',
      keys: [ring.recipients[0].keyId, ring.recipients[1].keyId],
    }),
    makeRawChat({
      chatId: OTHER_CHAT_ID,
      name: 'Дежурка',
      chatType: 'group_chat',
      updatedAt: '2026-09-07T07:00:00.000000Z',
      keys: [ring.recipients[0].keyId],
    }),
  ];
}

function sentFrames(): SentPayload[] {
  return server.mock.framesOf(MESSAGE_NEW_EVENT).map((frame) => frame.payload as SentPayload);
}

/** Снимает обёртку контент-ключа фикстурным ключом получателя и открывает тело события */
function decryptSent(sent: SentPayload, recipientIndex: 0 | 1): Record<string, unknown> {
  const wrapper = sent.keys.find((entry) => entry.key_id === ring.recipients[recipientIndex].keyId);
  if (wrapper === undefined) {
    throw new Error('в кадре нет обёртки на этого получателя');
  }
  const wrapped = sodium.from_base64(wrapper.key, sodium.base64_variants.ORIGINAL);
  const contentKey = sodium.crypto_box_open_easy(
    wrapped.slice(NONCE_BYTES),
    wrapped.slice(0, NONCE_BYTES),
    /* Отправитель это мой ключ обмена: приватная половина лежит в материале профиля как cts */
    ring.recipients[0].publicKey,
    ring.recipients[recipientIndex].privateKey,
  );

  const body = sodium.from_base64(sent.payload, sodium.base64_variants.ORIGINAL);
  const inner = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    body.slice(NONCE_BYTES),
    `${sent.group_chat_id}:${sent.sync_id}`,
    body.slice(0, NONCE_BYTES),
    contentKey,
  );
  return JSON.parse(new TextDecoder().decode(inner)) as Record<string, unknown>;
}

beforeAll(async () => {
  await sodium.ready;
  ring = await makeKeyRing();
});

beforeEach(async () => {
  sendRejects = false;
  server = await startToolServer({ ring, chats: chats() });
  server.mock.respondToTopic(`groupchat:${POLYGON_CHAT_ID}`, MESSAGE_NEW_EVENT, () =>
    sendRejects
      ? { status: 'error', response: { error: 'invalid_keys' } }
      : { status: 'ok', response: { inserted_at: INSERTED_AT } },
  );
});

afterEach(async () => {
  await server.close();
});

describe('отправка одним вызовом', () => {
  it('отправляет ровно один кадр на все ключи чата и отдаёт метку сервера', async () => {
    const payload = await server.callTool<SendMessageResult>('send_message', {
      chat: 'Избранное',
      text: TEXT,
    });
    if (payload.status !== 'sent') {
      throw new Error(`ожидалась отправка, пришло ${payload.status}`);
    }

    const frames = sentFrames();
    expect(frames).toHaveLength(1);
    const sent = frames[0];
    if (sent === undefined) {
      throw new Error('кадр отправки не найден');
    }

    expect(payload.chat_id).toBe(POLYGON_CHAT_ID);
    expect(payload.chat_name).toBe('Избранное');
    expect(payload.message_id).toBe(sent.sync_id);
    expect(payload.inserted_at).toBe(INSERTED_AT);

    expect(sent.group_chat_id).toBe(POLYGON_CHAT_ID);
    expect(sent.keys.map((entry) => entry.key_id)).toEqual([
      ring.recipients[0].keyId,
      ring.recipients[1].keyId,
    ]);
    expect(sent.payload.length).toBeGreaterThan(0);
    expect(sent.signature.sign_key_id).toBe(ring.sign.keyId);
    expect(
      sodium.crypto_sign_verify_detached(
        sodium.from_base64(sent.signature.sign, sodium.base64_variants.ORIGINAL),
        new TextEncoder().encode(sent.payload),
        ring.sign.publicKey,
      ),
    ).toBe(true);
  });

  it('отправленный кадр расшифровывается ключами КАЖДОГО получателя чата в исходный текст', async () => {
    await server.callTool<SendMessageResult>('send_message', {
      chat: 'Избранное',
      text: TEXT,
    });

    const sent = sentFrames()[0];
    if (sent === undefined) {
      throw new Error('кадр отправки не найден');
    }

    for (const index of [0, 1] as const) {
      const inner = decryptSent(sent, index);
      expect(inner['type']).toBe('text');
      expect(inner['body']).toBe(TEXT);
      expect(inner['group_chat_id']).toBe(POLYGON_CHAT_ID);
      expect(inner['lat']).toBe(0);
      expect(inner['stealth_forwarding']).toBe(false);
      /* Идентификатор сообщения свой и с идентификатором отправки не совпадает */
      expect(inner['msg_id']).not.toBe(sent.sync_id);
    }
  });

  it('неоднозначный и незнакомый запрос отказывают без единого кадра', async () => {
    const ambiguous = await server.callTool<SendMessageResult>('send_message', {
      chat: 'е',
      text: TEXT,
    });
    const missing = await server.callTool<SendMessageResult>('send_message', {
      chat: 'бухгалтерия',
      text: TEXT,
    });

    expect(ambiguous.status).toBe('ambiguous_chat');
    expect(missing.status).toBe('chat_not_found');
    expect(sentFrames()).toHaveLength(0);
  });

  it('повтор вызова шлёт второй кадр с новым идентификатором отправки', async () => {
    const first = await server.callTool<SendMessageResult>('send_message', {
      chat: 'Избранное',
      text: TEXT,
    });
    const second = await server.callTool<SendMessageResult>('send_message', {
      chat: 'Избранное',
      text: TEXT,
    });

    const frames = sentFrames();
    expect(frames).toHaveLength(2);
    expect(first.status === 'sent' && first.message_id).toBe(frames[0]?.sync_id);
    expect(second.status === 'sent' && second.message_id).toBe(frames[1]?.sync_id);
    expect(frames[0]?.sync_id).not.toBe(frames[1]?.sync_id);
  });
});

describe('отказ сервера на отправке', () => {
  it('доезжает до MCP с тегом слоя', async () => {
    sendRejects = true;

    const text = await server.callToolExpectingError('send_message', {
      chat: 'Избранное',
      text: TEXT,
    });

    expect(text).toContain('send_message:');
    expect(text).toContain('[phoenix] invalid_keys');
    expect(sentFrames()).toHaveLength(1);
  });
});
