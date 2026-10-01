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
import { EVENT_INFO_EVENT } from '../../src/protocol/eventInfo.js';
import { EVENTS_HISTORY_EVENT } from '../../src/protocol/history.js';
import { MESSAGE_NEW_EVENT } from '../../src/protocol/mutations.js';
import { makeKeyRing, type KeyRing } from '../helpers/cryptoFixtures.js';
import {
  OTHER_CHAT_ID,
  PEER_HUID,
  POLYGON_CHAT_ID,
  makeHistoryEvent,
  makeInnerText,
  makeRawChat,
  syncId,
} from '../helpers/readFixtures.js';
import { startToolServer, type ToolServer } from '../helpers/toolServer.js';

const INSERTED_AT = '2026-09-08T07:10:00.000Z';
const TEXT = 'привет из проверки';
const NONCE_BYTES = 24;
/** Цитируемое сообщение полигона и сообщение другого чата: оба лежат на подложном сервере */
const QUOTED_ID = syncId(11);
const FOREIGN_ID = syncId(12);
const MISSING_ID = syncId(13);
const QUOTED_TEXT = 'исходный вопрос';
const AUTHOR_NAME = 'Синтетический Автор';

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
let storedEvents: Record<string, unknown>[];

async function buildStoredEvents(): Promise<Record<string, unknown>[]> {
  const make = (id: string, chatId: string) =>
    makeHistoryEvent({
      syncId: id,
      groupChatId: chatId,
      insertedAt: '2026-09-08T07:00:00.000Z',
      sender: PEER_HUID,
      senderKeyId: ring.sender.keyId,
      senderPrivateKey: ring.sender.privateKey,
      recipient: ring.recipients[0],
      inner: makeInnerText({
        msgId: id,
        from: PEER_HUID,
        timestamp: '2026-09-08T07:00:00.000Z',
        groupChatId: chatId,
        body: QUOTED_TEXT,
      }),
    });
  return [await make(QUOTED_ID, POLYGON_CHAT_ID), await make(FOREIGN_ID, OTHER_CHAT_ID)];
}

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
  storedEvents = await buildStoredEvents();
  server = await startToolServer({
    ring,
    chats: chats(),
    profiles: [{ huid: PEER_HUID, name: AUTHOR_NAME }],
  });
  server.mock.respondTo(EVENT_INFO_EVENT, (frame) => {
    const requested = (frame.payload as Record<string, unknown>)['sync_ids'] as string[];
    return {
      status: 'ok',
      response: {
        info: storedEvents.filter((event) => requested.includes(event['sync_id'] as string)),
      },
    };
  });
  server.mock.respondTo(EVENTS_HISTORY_EVENT, () => ({ status: 'ok', response: { history: [] } }));
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

describe('ответ на сообщение', () => {
  it('кладёт во внутреннее событие цитату, собранную из самого сообщения', async () => {
    const payload = await server.callTool<SendMessageResult>('send_message', {
      chat: 'Избранное',
      text: TEXT,
      reply_to: QUOTED_ID,
    });
    if (payload.status !== 'sent') {
      throw new Error(`ожидалась отправка, пришло ${payload.status}`);
    }
    expect(payload.reply_to).toEqual({ message_id: QUOTED_ID });

    const frames = sentFrames();
    expect(frames).toHaveLength(1);
    const sent = frames[0];
    if (sent === undefined) {
      throw new Error('кадр отправки не найден');
    }
    const inner = decryptSent(sent, 0);
    expect(inner['body']).toBe(TEXT);
    expect(inner['reply']).toEqual({
      payload: { type: 'text', body: QUOTED_TEXT, from: PEER_HUID },
      sync_id: QUOTED_ID,
      sender_conn_type: 'cts',
      /* Чат с собой отдельного значения не имеет и считается личным */
      reply_type: 'chat',
      source_name: AUTHOR_NAME,
      group_chat_id: POLYGON_CHAT_ID,
    });
  });

  it('обычная отправка не несёт ни reply в событии, ни reply_to в ответе', async () => {
    const payload = await server.callTool<SendMessageResult>('send_message', {
      chat: 'Избранное',
      text: TEXT,
    });
    const sent = sentFrames()[0];
    if (sent === undefined) {
      throw new Error('кадр отправки не найден');
    }

    expect(Object.keys(payload)).not.toContain('reply_to');
    expect(Object.keys(decryptSent(sent, 0))).not.toContain('reply');
  });

  it('несуществующее и чужое сообщение дают reply_target_not_found без единого кадра', async () => {
    for (const target of [MISSING_ID, FOREIGN_ID]) {
      const payload = await server.callTool<SendMessageResult>('send_message', {
        chat: 'Избранное',
        text: TEXT,
        reply_to: target,
      });
      expect(payload.status).toBe('reply_target_not_found');
      expect(payload.status === 'reply_target_not_found' && payload.next_step.length).toBeGreaterThan(0);
    }
    expect(sentFrames()).toHaveLength(0);
  });

  it('адрес не в форме UUID отвергается схемой без единого кадра', async () => {
    await server.callToolExpectingError('send_message', {
      chat: 'Избранное',
      text: TEXT,
      reply_to: 'не-идентификатор',
    });

    expect(sentFrames()).toHaveLength(0);
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
