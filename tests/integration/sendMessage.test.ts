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
  MY_HUID,
  OTHER_CHAT_ID,
  PEER_HUID,
  SECOND_PEER_HUID,
  POLYGON_CHAT_ID,
  makeHistoryEvent,
  makeInnerText,
  makeMentions,
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
/** Второй участник группы с тем же первым словом имени: на нём проверяется неоднозначность */
const SECOND_NAME = 'Синтетический Второй';
const MY_NAME = 'Проверкин Иван Сергеевич';
/** Участник с символами, особыми для регулярных выражений и шаблонов замены */
const SYMBOL_HUID = '88888888-8888-5888-8888-888888888888';
const SYMBOL_NAME = 'Знаков $& [Тест].*';
const PLACEHOLDER = /@\{mention:([0-9a-f-]{36})\}/g;

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
      memberHuids: [MY_HUID, PEER_HUID, SECOND_PEER_HUID, SYMBOL_HUID],
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
    profiles: [
      { huid: PEER_HUID, name: AUTHOR_NAME },
      { huid: SECOND_PEER_HUID, name: SECOND_NAME },
      { huid: MY_HUID, name: MY_NAME },
      { huid: SYMBOL_HUID, name: SYMBOL_NAME },
    ],
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
  server.mock.respondToTopic(`groupchat:${OTHER_CHAT_ID}`, MESSAGE_NEW_EVENT, () => ({
    status: 'ok',
    response: { inserted_at: INSERTED_AT },
  }));
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

function singleSent(): SentPayload {
  const frames = sentFrames();
  expect(frames).toHaveLength(1);
  const sent = frames[0];
  if (sent === undefined) {
    throw new Error('кадр отправки не найден');
  }
  return sent;
}

/** Идентификаторы плейсхолдеров тела в порядке появления */
function placeholderIds(body: unknown): string[] {
  return [...String(body).matchAll(PLACEHOLDER)].map((match) => match[1] ?? '');
}

describe('упоминания', () => {
  it('маркер с huid меняется на плейсхолдер, а mentions[] едет в форме живой пробы', async () => {
    const payload = await server.callTool<SendMessageResult>('send_message', {
      chat: 'Дежурка',
      text: `@{mention:${PEER_HUID}} посмотри, пожалуйста`,
      mentions: [PEER_HUID],
    });
    if (payload.status !== 'sent') {
      throw new Error(`ожидалась отправка, пришло ${payload.status}`);
    }
    expect(payload.mentions).toEqual([{ huid: PEER_HUID, name: AUTHOR_NAME }]);

    const inner = decryptSent(singleSent(), 0);
    const [mentionId] = placeholderIds(inner['body']);
    expect(inner['body']).toBe(`@{mention:${mentionId}} посмотри, пожалуйста`);
    expect(mentionId).not.toBe(PEER_HUID);
    expect(inner['mentions']).toEqual(
      makeMentions([{ mentionId: mentionId ?? '', huid: PEER_HUID, name: AUTHOR_NAME }]),
    );
  });

  it('имя на входе ищется в тексте как @Имя, а huid на входе находит имя из справки', async () => {
    const payload = await server.callTool<SendMessageResult>('send_message', {
      chat: 'Дежурка',
      text: `@${AUTHOR_NAME} и @${SECOND_NAME}, глянете ревью?`,
      mentions: ['синтетический автор', SECOND_PEER_HUID],
    });
    if (payload.status !== 'sent') {
      throw new Error(`ожидалась отправка, пришло ${payload.status}`);
    }
    expect(payload.mentions).toEqual([
      { huid: PEER_HUID, name: AUTHOR_NAME },
      { huid: SECOND_PEER_HUID, name: SECOND_NAME },
    ]);

    const inner = decryptSent(singleSent(), 0);
    const [firstId, secondId] = placeholderIds(inner['body']);
    expect(inner['body']).toBe(`@{mention:${firstId}} и @{mention:${secondId}}, глянете ревью?`);
    expect(inner['mentions']).toEqual(
      makeMentions([
        { mentionId: firstId ?? '', huid: PEER_HUID, name: AUTHOR_NAME },
        { mentionId: secondId ?? '', huid: SECOND_PEER_HUID, name: SECOND_NAME },
      ]),
    );
  });

  it('работает вместе с ответом на сообщение', async () => {
    const payload = await server.callTool<SendMessageResult>('send_message', {
      chat: 'Избранное',
      text: `@${MY_NAME} напоминание`,
      mentions: ['Иван'],
      reply_to: QUOTED_ID,
    });
    if (payload.status !== 'sent') {
      throw new Error(`ожидалась отправка, пришло ${payload.status}`);
    }
    expect(payload.reply_to).toEqual({ message_id: QUOTED_ID });
    expect(payload.mentions).toEqual([{ huid: MY_HUID, name: MY_NAME }]);

    const inner = decryptSent(singleSent(), 0);
    const [mentionId] = placeholderIds(inner['body']);
    expect(inner['body']).toBe(`@{mention:${mentionId}} напоминание`);
    expect(inner['mentions']).toEqual(
      makeMentions([{ mentionId: mentionId ?? '', huid: MY_HUID, name: MY_NAME }]),
    );
    expect((inner['reply'] as Record<string, unknown>)['sync_id']).toBe(QUOTED_ID);
  });

  it('обычная отправка не несёт mentions ни в событии, ни в ответе', async () => {
    const payload = await server.callTool<SendMessageResult>('send_message', {
      chat: 'Избранное',
      text: TEXT,
    });
    expect(Object.keys(payload)).not.toContain('mentions');
    expect(Object.keys(decryptSent(singleSent(), 0))).not.toContain('mentions');
  });

  it('ненайденный человек и huid не из чата дают mention_not_found без единого кадра', async () => {
    for (const mention of ['Бухгалтеров', MY_HUID]) {
      const payload = await server.callTool<SendMessageResult>('send_message', {
        chat: 'Избранное',
        text: `@${mention} привет`,
        mentions: mention === MY_HUID ? [PEER_HUID] : [mention],
      });
      expect(payload.status).toBe('mention_not_found');
    }
    expect(sentFrames()).toHaveLength(0);
  });

  it('неоднозначное имя даёт ambiguous_mention с кандидатами без единого кадра', async () => {
    const payload = await server.callTool<SendMessageResult>('send_message', {
      chat: 'Дежурка',
      text: '@Синтетический привет',
      mentions: ['Синтетический'],
    });
    expect(payload).toMatchObject({
      status: 'ambiguous_mention',
      mention: 'Синтетический',
      candidates: [
        { huid: PEER_HUID, name: AUTHOR_NAME },
        { huid: SECOND_PEER_HUID, name: SECOND_NAME },
      ],
    });
    expect(sentFrames()).toHaveLength(0);
  });

  it('без маркера и имени в тексте отвечает mention_not_in_text с искомым без единого кадра', async () => {
    const payload = await server.callTool<SendMessageResult>('send_message', {
      chat: 'Дежурка',
      text: 'посмотрите, пожалуйста',
      mentions: [PEER_HUID],
    });
    expect(payload).toMatchObject({
      status: 'mention_not_in_text',
      mention: PEER_HUID,
      searched: [`@{mention:${PEER_HUID}}`, `@${AUTHOR_NAME}`, `@${PEER_HUID}`],
    });
    expect(sentFrames()).toHaveLength(0);
  });

  it('имя внутри более длинного слова не считается упоминанием', async () => {
    const onlyLonger = await server.callTool<SendMessageResult>('send_message', {
      chat: 'Дежурка',
      text: `@${AUTHOR_NAME}ов и @${AUTHOR_NAME}у привет`,
      mentions: [PEER_HUID],
    });
    expect(onlyLonger.status).toBe('mention_not_in_text');
    expect(sentFrames()).toHaveLength(0);

    await server.callTool<SendMessageResult>('send_message', {
      chat: 'Дежурка',
      text: `@${AUTHOR_NAME}ов уже смотрел, @${AUTHOR_NAME}, глянь`,
      mentions: [PEER_HUID],
    });
    const inner = decryptSent(singleSent(), 0);
    const [mentionId] = placeholderIds(inner['body']);
    expect(inner['body']).toBe(`@${AUTHOR_NAME}ов уже смотрел, @{mention:${mentionId}}, глянь`);
  });

  it('вход как передан ищется после полного имени', async () => {
    await server.callTool<SendMessageResult>('send_message', {
      chat: 'Дежурка',
      text: '@синтетический автор, привет',
      mentions: ['синтетический автор'],
    });
    const inner = decryptSent(singleSent(), 0);
    const [mentionId] = placeholderIds(inner['body']);
    expect(inner['body']).toBe(`@{mention:${mentionId}}, привет`);
  });

  it('один вход заменяет одно вхождение, повтор человека во входе заменяет второе', async () => {
    const text = `@${AUTHOR_NAME} и снова @${AUTHOR_NAME}`;
    await server.callTool<SendMessageResult>('send_message', {
      chat: 'Дежурка',
      text,
      mentions: [PEER_HUID],
    });
    await server.callTool<SendMessageResult>('send_message', {
      chat: 'Дежурка',
      text,
      mentions: [PEER_HUID, PEER_HUID],
    });

    const [once, twice] = sentFrames();
    if (once === undefined || twice === undefined) {
      throw new Error('ожидались два кадра');
    }
    const onceInner = decryptSent(once, 0);
    const [onlyId] = placeholderIds(onceInner['body']);
    expect(onceInner['body']).toBe(`@{mention:${onlyId}} и снова @${AUTHOR_NAME}`);

    const twiceInner = decryptSent(twice, 0);
    const [firstId, secondId] = placeholderIds(twiceInner['body']);
    expect(firstId).not.toBe(secondId);
    expect(twiceInner['body']).toBe(`@{mention:${firstId}} и снова @{mention:${secondId}}`);
    expect((twiceInner['mentions'] as unknown[]).length).toBe(2);
  });

  it('символы шаблонов и регулярных выражений в имени не ломают замену', async () => {
    await server.callTool<SendMessageResult>('send_message', {
      chat: 'Дежурка',
      text: `$1 @${SYMBOL_NAME} привет`,
      mentions: [SYMBOL_HUID],
    });
    const inner = decryptSent(singleSent(), 0);
    const [mentionId] = placeholderIds(inner['body']);
    expect(inner['body']).toBe(`$1 @{mention:${mentionId}} привет`);
    expect(inner['mentions']).toEqual(
      makeMentions([{ mentionId: mentionId ?? '', huid: SYMBOL_HUID, name: SYMBOL_NAME }]),
    );
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
