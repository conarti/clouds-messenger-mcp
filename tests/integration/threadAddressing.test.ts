/**
 * Тред по собственному адресу и по ссылке xlnk: отправка в тред и чтение без родителя.
 *
 * Тред в списке чатов отсутствует, его знает только справка `thread_info`. Родитель в списке
 * чатов есть, и из него тред берёт имя и участников. Кадр отправки проверяется расшифровкой
 * ключами получателей треда, а не сверкой с нашим же сборщиком.
 *
 * ГЛАВНОЕ ОГРАНИЧЕНИЕ: ни один путь не отправляет `thread_join`, он делает пользователя
 * участником треда. Проверяется после каждого сценария по журналу кадров всех соединений.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sodium from 'libsodium-wrappers-sumo';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DownloadAttachmentResult } from '../../src/mcp/tools/downloadAttachment.js';
import type { GetMessageResult } from '../../src/mcp/tools/getMessage.js';
import type { GetMessageContextResult } from '../../src/mcp/tools/getMessageContext.js';
import type { GetThreadResult } from '../../src/mcp/tools/getThread.js';
import type { SendMessageResult } from '../../src/mcp/tools/sendMessage.js';
import { EVENT_INFO_EVENT } from '../../src/protocol/eventInfo.js';
import { EVENTS_HISTORY_EVENT } from '../../src/protocol/history.js';
import { MESSAGE_NEW_EVENT } from '../../src/protocol/mutations.js';
import { THREAD_INFO_EVENT, THREAD_LIST_EVENT } from '../../src/protocol/threads.js';
import { makeKeyRing, type KeyRing } from '../helpers/cryptoFixtures.js';
import {
  MY_HUID,
  OTHER_CHAT_ID,
  PEER_HUID,
  POLYGON_CHAT_ID,
  makeHistoryEvent,
  makeInnerImage,
  makeInnerText,
  makeMentions,
  makeRawChat,
  syncId,
} from '../helpers/readFixtures.js';
import { startToolServer, type ToolServer } from '../helpers/toolServer.js';

/** Тред группы «Дежурка»: адрес равен адресу стартового сообщения в родителе */
const THREAD_ID = 'c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f';
/** Тред чата, которого нет в списке чатов */
const ORPHAN_THREAD_ID = 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f7a';
const ABSENT_PARENT_ID = 'e5f6a7b8-c9d0-4e1f-8a2b-3c4d5e6f7a8b';
const UNKNOWN_ID = 'f6a7b8c9-d0e1-4f2a-8b3c-4d5e6f7a8b9c';
const THREAD_JOIN_EVENT = 'thread_join';
const NONCE_BYTES = 24;
const INSERTED_AT = '2026-09-17T09:00:00.000Z';
const AUTHOR_NAME = 'Синтетический Автор';
const FILE_ID = 'c0ffee00-0000-4000-8000-000000000002';
const QUOTED_ID = syncId(21);
const IMAGE_ID = syncId(22);
/** Сообщение «Избранного»: адресное чтение его находит, но ни «Дежурке», ни её тредам оно не принадлежит */
const UNRELATED_ID = syncId(23);

interface SentPayload {
  keys: Array<{ key_id: string; key: string; algo: string }>;
  group_chat_id: string;
  sync_id: string;
  payload: string;
}

let ring: KeyRing;
let server: ToolServer;
let threadEvents: Record<string, unknown>[];
let fileServiceCalls: string[];
let downloadsDir: string;

function threadInfo(threadId: string, parentId: string): Record<string, unknown> {
  return {
    thread_id: threadId,
    group_chat_id: parentId,
    counter: 2,
    /* Получатели треда это набор родителя, но здесь он намеренно другой, чем у записи чата */
    keys: [ring.recipients[0].keyId, ring.recipients[1].keyId],
    active: false,
  };
}

async function buildThreadEvents(): Promise<Record<string, unknown>[]> {
  const common = {
    groupChatId: THREAD_ID,
    sender: PEER_HUID,
    senderKeyId: ring.sender.keyId,
    senderPrivateKey: ring.sender.privateKey,
    recipient: ring.recipients[0],
  };
  return [
    await makeHistoryEvent({
      ...common,
      syncId: QUOTED_ID,
      insertedAt: '2026-09-17T08:00:00.000Z',
      inner: makeInnerText({
        msgId: QUOTED_ID,
        from: PEER_HUID,
        timestamp: '2026-09-17T08:00:00.000Z',
        groupChatId: THREAD_ID,
        body: 'ответ коллеги в треде',
      }),
    }),
    await makeHistoryEvent({
      ...common,
      syncId: IMAGE_ID,
      insertedAt: '2026-09-17T08:01:00.000Z',
      inner: makeInnerImage({
        msgId: IMAGE_ID,
        from: PEER_HUID,
        timestamp: '2026-09-17T08:01:00.000Z',
        groupChatId: THREAD_ID,
        fileId: FILE_ID,
        fileName: 'схема.png',
      }),
    }),
  ];
}

function sentFrames(): SentPayload[] {
  return server.mock.framesOf(MESSAGE_NEW_EVENT).map((frame) => frame.payload as SentPayload);
}

function singleSent(): SentPayload {
  const frames = sentFrames();
  expect(frames).toHaveLength(1);
  const sent = frames[0];
  if (sent === undefined) {
    throw new Error('кадр отправки не найден');
  }
  return sent;
}

/** Открывает тело кадра фикстурным ключом получателя: так видно, что получатели верные */
function decryptSent(sent: SentPayload, recipientIndex: 0 | 1): Record<string, unknown> {
  const wrapper = sent.keys.find((entry) => entry.key_id === ring.recipients[recipientIndex].keyId);
  if (wrapper === undefined) {
    throw new Error('в кадре нет обёртки на этого получателя');
  }
  const wrapped = sodium.from_base64(wrapper.key, sodium.base64_variants.ORIGINAL);
  const contentKey = sodium.crypto_box_open_easy(
    wrapped.slice(NONCE_BYTES),
    wrapped.slice(0, NONCE_BYTES),
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

function linkTo(messageId: string, chatId: string): string {
  return `https://xlnk.clouds.org.ru/open/message?sync_id=${messageId}&chat_id=${chatId}`;
}

beforeAll(async () => {
  await sodium.ready;
  ring = await makeKeyRing();
});

beforeEach(async () => {
  threadEvents = [
    ...(await buildThreadEvents()),
    await makeHistoryEvent({
      syncId: UNRELATED_ID,
      groupChatId: POLYGON_CHAT_ID,
      insertedAt: '2026-09-17T08:02:00.000Z',
      sender: MY_HUID,
      senderKeyId: ring.sender.keyId,
      senderPrivateKey: ring.sender.privateKey,
      recipient: ring.recipients[0],
      inner: makeInnerText({
        msgId: UNRELATED_ID,
        from: MY_HUID,
        timestamp: '2026-09-17T08:02:00.000Z',
        groupChatId: POLYGON_CHAT_ID,
        body: 'заметка себе',
      }),
    }),
  ];
  fileServiceCalls = [];
  downloadsDir = await mkdtemp(join(tmpdir(), 'clouds-thread-downloads-'));
  server = await startToolServer({
    ring,
    chats: [
      makeRawChat({ chatId: POLYGON_CHAT_ID, name: 'Избранное', chatType: 'notes' }),
      makeRawChat({
        chatId: OTHER_CHAT_ID,
        name: 'Дежурка',
        chatType: 'group_chat',
        keys: [ring.recipients[0].keyId],
        memberHuids: [MY_HUID, PEER_HUID],
      }),
    ],
    profiles: [{ huid: PEER_HUID, name: AUTHOR_NAME }],
    configOverrides: { paths: { downloadsDir } },
  });

  const known = [threadInfo(THREAD_ID, OTHER_CHAT_ID), threadInfo(ORPHAN_THREAD_ID, ABSENT_PARENT_ID)];
  /* Пользователь ни в одном треде не участник: список подписок пуст */
  server.mock.respondTo(THREAD_LIST_EVENT, () => ({
    status: 'ok',
    response: { [THREAD_LIST_EVENT]: [] },
  }));
  server.mock.respondTo(THREAD_INFO_EVENT, (frame) => {
    const payload = frame.payload as Record<string, unknown>;
    const info = known.find((thread) => thread['thread_id'] === payload['thread_id']);
    return info === undefined
      ? { status: 'error', response: { error: 'thread_not_found' } }
      : { status: 'ok', response: { [THREAD_INFO_EVENT]: info } };
  });
  server.mock.respondTo(EVENT_INFO_EVENT, (frame) => {
    const requested = (frame.payload as Record<string, unknown>)['sync_ids'] as string[];
    return {
      status: 'ok',
      response: { info: threadEvents.filter((event) => requested.includes(event['sync_id'] as string)) },
    };
  });
  server.mock.respondTo(EVENTS_HISTORY_EVENT, (frame) => {
    const payload = frame.payload as Record<string, unknown>;
    const events =
      payload['group_chat_id'] === THREAD_ID
        ? threadEvents.filter((event) => event['group_chat_id'] === THREAD_ID)
        : [];
    return { status: 'ok', response: { history: [...events].reverse(), has_more: false } };
  });
  server.mock.respondToTopic(`groupchat:${THREAD_ID}`, MESSAGE_NEW_EVENT, () => ({
    status: 'ok',
    response: { inserted_at: INSERTED_AT },
  }));
  server.mock.respondToTopic(`groupchat:${ORPHAN_THREAD_ID}`, MESSAGE_NEW_EVENT, () => ({
    status: 'ok',
    response: { inserted_at: INSERTED_AT },
  }));

  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0]) => {
    fileServiceCalls.push(String(input));
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  });
});

afterEach(async () => {
  /* Ни отправка, ни чтение не делают пользователя участником треда */
  expect(server.mock.framesOf(THREAD_JOIN_EVENT)).toHaveLength(0);
  vi.unstubAllGlobals();
  await server.close();
  await rm(downloadsDir, { recursive: true, force: true });
});

describe('send_message в тред', () => {
  it('адрес треда в chat: кадр в топике треда, адрес треда снаружи и внутри, ключи треда', async () => {
    const payload = await server.callTool<SendMessageResult>('send_message', {
      chat: THREAD_ID,
      text: 'уточняющий вопрос',
    });
    if (payload.status !== 'sent') {
      throw new Error(`ожидалась отправка, пришло ${payload.status}`);
    }

    expect(payload.chat_id).toBe(THREAD_ID);
    expect(payload.parent_chat_id).toBe(OTHER_CHAT_ID);
    expect(payload.chat_name).toBe('Дежурка');

    const frames = server.mock.framesOf(MESSAGE_NEW_EVENT);
    expect(frames.map((frame) => frame.topic)).toEqual([`groupchat:${THREAD_ID}`]);
    const sent = singleSent();
    expect(sent.group_chat_id).toBe(THREAD_ID);
    expect(sent.keys.map((entry) => entry.key_id)).toEqual([
      ring.recipients[0].keyId,
      ring.recipients[1].keyId,
    ]);
    for (const index of [0, 1] as const) {
      const inner = decryptSent(sent, index);
      expect(inner['group_chat_id']).toBe(THREAD_ID);
      expect(inner['body']).toBe('уточняющий вопрос');
      expect(JSON.stringify(inner)).not.toContain(OTHER_CHAT_ID);
    }
  });

  it.each([
    ['thread_id', { thread_id: THREAD_ID }],
    ['message_id стартового сообщения', { message_id: THREAD_ID }],
  ])('родительский чат плюс %s дают тот же кадр', async (_label, threadArgs) => {
    const payload = await server.callTool<SendMessageResult>('send_message', {
      chat: 'Дежурка',
      text: 'уточняющий вопрос',
      ...threadArgs,
    });

    expect(payload.status === 'sent' && payload.chat_id).toBe(THREAD_ID);
    expect(server.mock.framesOf(MESSAGE_NEW_EVENT).map((frame) => frame.topic)).toEqual([
      `groupchat:${THREAD_ID}`,
    ]);
    expect(decryptSent(singleSent(), 1)['group_chat_id']).toBe(THREAD_ID);
  });

  it('ссылка xlnk в chat отправляет в тред по её chat_id', async () => {
    const payload = await server.callTool<SendMessageResult>('send_message', {
      chat: linkTo(QUOTED_ID, THREAD_ID),
      text: 'уточняющий вопрос',
    });

    expect(payload.status === 'sent' && payload.chat_id).toBe(THREAD_ID);
  });

  it('тред, которого нет, либо тред другого чата: статус и ноль кадров', async () => {
    const missing = await server.callTool<SendMessageResult>('send_message', {
      chat: 'Дежурка',
      text: 'текст',
      thread_id: UNKNOWN_ID,
    });
    const foreign = await server.callTool<SendMessageResult>('send_message', {
      chat: 'Избранное',
      text: 'текст',
      thread_id: THREAD_ID,
    });
    const mismatch = await server.callTool<SendMessageResult>('send_message', {
      chat: THREAD_ID,
      text: 'текст',
      thread_id: ORPHAN_THREAD_ID,
    });
    const unknownChat = await server.callTool<SendMessageResult>('send_message', {
      chat: UNKNOWN_ID,
      text: 'текст',
    });

    expect(missing.status).toBe('thread_not_found');
    expect(foreign.status).toBe('thread_not_found');
    expect(mismatch.status).toBe('thread_not_found');
    expect(unknownChat.status).toBe('chat_not_found');
    expect(sentFrames()).toHaveLength(0);
  });

  it('ответ и упоминание в треде: цитата берётся из треда, участники из родителя', async () => {
    const payload = await server.callTool<SendMessageResult>('send_message', {
      chat: THREAD_ID,
      text: `@${AUTHOR_NAME} уточни, пожалуйста`,
      reply_to: QUOTED_ID,
      mentions: [PEER_HUID],
    });
    if (payload.status !== 'sent') {
      throw new Error(`ожидалась отправка, пришло ${payload.status}`);
    }

    const inner = decryptSent(singleSent(), 0);
    const reply = inner['reply'] as Record<string, unknown>;
    expect(reply['sync_id']).toBe(QUOTED_ID);
    expect(reply['group_chat_id']).toBe(THREAD_ID);
    expect((reply['payload'] as Record<string, unknown>)['body']).toBe('ответ коллеги в треде');
    const mentionId = /@\{mention:([0-9a-f-]{36})\}/.exec(String(inner['body']))?.[1] ?? '';
    expect(inner['mentions']).toEqual(
      makeMentions([{ mentionId, huid: PEER_HUID, name: AUTHOR_NAME }]),
    );
  });

  it('тред чата вне списка отправляется без имени, на ключи треда', async () => {
    const payload = await server.callTool<SendMessageResult>('send_message', {
      chat: ORPHAN_THREAD_ID,
      text: 'текст',
    });
    if (payload.status !== 'sent') {
      throw new Error(`ожидалась отправка, пришло ${payload.status}`);
    }

    expect(payload.parent_chat_id).toBe(ABSENT_PARENT_ID);
    expect(Object.keys(payload)).not.toContain('chat_name');
    expect(singleSent().keys).toHaveLength(2);
  });
});

describe('чтение по адресу треда и по ссылке', () => {
  it('get_thread с адресом треда в chat не спрашивает список тредов и находит тред', async () => {
    const payload = await server.callTool<GetThreadResult>('get_thread', { chat: THREAD_ID });
    if (payload.status !== 'ok') {
      throw new Error(`ожидалась выдача, пришло ${payload.status}`);
    }

    expect(payload.thread_id).toBe(THREAD_ID);
    expect(payload.chat_id).toBe(OTHER_CHAT_ID);
    expect(payload.source).toBe('direct');
    expect(payload.participant).toBe(false);
    expect(payload.messages).toHaveLength(2);
    expect(server.mock.framesOf(THREAD_LIST_EVENT)).toHaveLength(0);
    expect(server.mock.framesOf(THREAD_INFO_EVENT)).toHaveLength(1);
    expect(JSON.stringify(payload)).not.toContain(ring.recipients[1].keyId);
  });

  it('get_message по адресу треда и по ссылке без message_id', async () => {
    const byAddress = await server.callTool<GetMessageResult>('get_message', {
      chat: THREAD_ID,
      message_id: QUOTED_ID,
    });
    const byLink = await server.callTool<GetMessageResult>('get_message', {
      chat: linkTo(QUOTED_ID, THREAD_ID),
    });

    expect(byAddress.status === 'ok' && byAddress.message.text).toBe('ответ коллеги в треде');
    expect(byLink.status === 'ok' && byLink.chat_id).toBe(THREAD_ID);
    expect(byLink.status === 'ok' && byLink.message.message_id).toBe(QUOTED_ID);
  });

  it('get_message по ссылке с адресом родителя отдаёт адрес треда, и ответ по нему уходит в тред', async () => {
    const read = await server.callTool<GetMessageResult>('get_message', {
      chat: linkTo(QUOTED_ID, OTHER_CHAT_ID),
    });
    if (read.status !== 'ok') {
      throw new Error(`ожидалась выдача, пришло ${read.status}`);
    }
    expect(read.chat_id).toBe(THREAD_ID);
    expect(read.message.chat_kind).toBe('thread');

    const sent = await server.callTool<SendMessageResult>('send_message', {
      chat: read.chat_id,
      text: 'ответ по ссылке',
      reply_to: read.message.message_id,
    });

    expect(sent.status === 'sent' && sent.reply_to).toEqual({ message_id: QUOTED_ID });
    const inner = decryptSent(singleSent(), 0);
    const reply = inner['reply'] as Record<string, unknown>;
    expect(reply['group_chat_id']).toBe(THREAD_ID);
    /* Тип ответа берётся у родителя: «Дежурка» групповой чат */
    expect(reply['reply_type']).toBe('group_chat');
  });

  it('сообщение постороннего чата это message_not_found во всех трёх инструментах', async () => {
    const args = { chat: 'Дежурка', message_id: UNRELATED_ID };

    const message = await server.callTool<GetMessageResult>('get_message', args);
    const context = await server.callTool<GetMessageContextResult>('get_message_context', args);
    const download = await server.callTool<DownloadAttachmentResult>('download_attachment', args);

    for (const payload of [message, context, download]) {
      expect(payload.status).toBe('message_not_found');
      expect(payload.status === 'message_not_found' && payload.reason).toContain('не в его треде');
    }
    expect(fileServiceCalls).toHaveLength(0);
    expect(server.mock.framesOf(EVENTS_HISTORY_EVENT)).toHaveLength(0);
  });

  it('явный message_id старше sync_id ссылки', async () => {
    const payload = await server.callTool<GetMessageResult>('get_message', {
      chat: linkTo(QUOTED_ID, THREAD_ID),
      message_id: IMAGE_ID,
    });

    expect(payload.status === 'ok' && payload.message.message_id).toBe(IMAGE_ID);
  });

  it('без message_id и без ссылки: invalid_input без единого кадра', async () => {
    const payload = await server.callTool<GetMessageResult>('get_message', { chat: THREAD_ID });

    expect(payload.status).toBe('invalid_input');
    expect(server.mock.framesOf(EVENT_INFO_EVENT)).toHaveLength(0);
  });

  it('get_message_context по ссылке с адресом родителя строит окно по истории треда', async () => {
    const payload = await server.callTool<GetMessageContextResult>('get_message_context', {
      chat: linkTo(IMAGE_ID, OTHER_CHAT_ID),
      before_count: 1,
      after_count: 0,
    });
    if (payload.status !== 'ok') {
      throw new Error(`ожидалась выдача, пришло ${payload.status}`);
    }

    expect(payload.chat_id).toBe(THREAD_ID);
    expect(payload.pivot_message_id).toBe(IMAGE_ID);
    expect(
      server.mock
        .framesOf(EVENTS_HISTORY_EVENT)
        .every((frame) => frame.topic === `groupchat:${THREAD_ID}`),
    ).toBe(true);
  });

  it.each([
    ['адрес треда', () => ({ chat: THREAD_ID, message_id: IMAGE_ID })],
    ['ссылка с адресом треда', () => ({ chat: linkTo(IMAGE_ID, THREAD_ID) })],
    ['ссылка с адресом родителя', () => ({ chat: linkTo(IMAGE_ID, OTHER_CHAT_ID) })],
  ])('download_attachment из треда идёт в файловую службу адресом треда: %s', async (_label, args) => {
    const payload = await server.callTool<DownloadAttachmentResult>('download_attachment', args());

    expect(payload.status).toBe('ok');
    expect(fileServiceCalls).toHaveLength(1);
    expect(fileServiceCalls[0]).toContain(`/${THREAD_ID}/`);
    expect(fileServiceCalls[0]).not.toContain(OTHER_CHAT_ID);
  });
});
