/**
 * Страница истории: форма запроса, порядок, курсор и окно дат.
 *
 * Подложный сервер здесь СОЗНАТЕЛЬНО отдаёт страницу от новых к старым и ВКЛЮЧАЕТ событие
 * курсора: живьём ни порядок элементов, ни включающая семантика `skip_to_sync_id_event` не
 * установлены, и код обязан выдерживать именно эту, неудобную для себя, трактовку. Если бы
 * подложный сервер отдавал сразу удобное, проверка доказывала бы только саму себя.
 */
import { describe, expect, it } from 'vitest';
import type { AuthProvider } from '../../src/auth/AuthProvider.js';
import type { KeyStore } from '../../src/auth/keyStore.js';
import type { CryptoService } from '../../src/crypto/types.js';
import { MAX_HISTORY_PAGES, getHistory } from '../../src/mcp/tools/getHistory.js';
import type { ToolDeps } from '../../src/mcp/tools/deps.js';
import { CHAT_LIST_EVENT } from '../../src/protocol/chatList.js';
import { buildEventsHistoryPayload, fetchHistoryPage } from '../../src/protocol/history.js';
import type { RestClient } from '../../src/transport/types.js';
import type { PhoenixClient } from '../../src/transport/ws/types.js';
import { createLogger } from '../../src/util/logger.js';
import { makeInnerText, makeRawChat, syncId, MY_HUID, POLYGON_CHAT_ID } from '../helpers/readFixtures.js';
import { createTestConfig } from '../helpers/testConfig.js';

/** День сентября, чтобы окно по датам читалось глазами: событие index приходится на 0index */
function dayIso(index: number): string {
  return `2026-09-0${index}T12:00:00.000Z`;
}

interface RecordedCall {
  topic: string;
  event: string;
  payload: Record<string, unknown>;
}

type Responder = (call: RecordedCall) => unknown;

function forbidden(what: string): () => never {
  return () => {
    throw new Error(`${what}: этот путь в проверке не участвует`);
  };
}

function createDeps(
  responder: Responder,
  inner: Map<string, Record<string, unknown>>,
): { deps: ToolDeps; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const ws: PhoenixClient = {
    request: (async (topic: string, event: string, payload: unknown) => {
      const call: RecordedCall = { topic, event, payload: payload as Record<string, unknown> };
      calls.push(call);
      return responder(call);
    }) as PhoenixClient['request'],
    close: async () => undefined,
  };
  const crypto: CryptoService = {
    keys: {
      senderPublicKey: async () => new Uint8Array(32),
      resolveRecipientPublicKeys: async () => [],
    },
    decryptEvent: async (event) => inner.get(event.sync_id) ?? {},
    encryptMessage: forbidden('crypto.encryptMessage'),
  };
  const keyStore: KeyStore = {
    match: async () => new Uint8Array(32),
    require: async () => new Uint8Array(32),
  };
  const rest: RestClient = {
    getJson: forbidden('rest.getJson'),
    postJson: forbidden('rest.postJson'),
    getKdcKeys: forbidden('rest.getKdcKeys'),
  };
  const auth: AuthProvider = {
    getBearer: forbidden('auth.getBearer'),
    getCookieHeader: forbidden('auth.getCookieHeader'),
    getWhoami: forbidden('auth.getWhoami'),
    getKeyMaterial: forbidden('auth.getKeyMaterial'),
    onAuthFailure: forbidden('auth.onAuthFailure'),
  };

  return {
    deps: {
      ws,
      rest,
      auth,
      crypto,
      keyStore,
      config: createTestConfig(),
      logger: createLogger({ level: 'error' }),
    },
    calls,
  };
}

/** Девять событий по одному на день сентября, от старых к новым */
function buildEvents(): { events: Record<string, unknown>[]; inner: Map<string, Record<string, unknown>> } {
  const events: Record<string, unknown>[] = [];
  const inner = new Map<string, Record<string, unknown>>();
  for (let index = 1; index <= 9; index += 1) {
    const id = syncId(index);
    events.push({
      sync_id: id,
      group_chat_id: POLYGON_CHAT_ID,
      event_type: 'message_new',
      inserted_at: dayIso(index),
      sender: MY_HUID,
      sender_key_id: 'sender-key-id',
      read_by: [],
      key: { key_id: 'recipient-key-id-a', key: 'подложная обёртка', algo: 'xsalsa20:xchacha20_aead_ietf' },
      payload: 'подложный шифротекст',
    });
    inner.set(
      id,
      makeInnerText({
        msgId: id,
        from: MY_HUID,
        timestamp: dayIso(index),
        groupChatId: POLYGON_CHAT_ID,
        body: `сообщение дня ${index}`,
      }),
    );
  }
  return { events, inner };
}

/** Подложный сервер: включает событие курсора и отдаёт страницу от новых к старым */
function historyResponder(
  events: readonly Record<string, unknown>[],
  hasMore?: boolean,
): (payload: Record<string, unknown>) => unknown {
  return (payload) => {
    const cursor = payload['sync_id'];
    const limit = payload['limit'] as number;
    const direction = payload['direction'];
    let pool = [...events];
    if (typeof cursor === 'string') {
      const at = pool.findIndex((event) => event['sync_id'] === cursor);
      pool = direction === 'forward' ? pool.slice(at) : pool.slice(0, at + 1);
    }
    const slice = direction === 'forward' ? pool.slice(0, limit) : pool.slice(-limit);
    return { history: [...slice].reverse(), ...(hasMore !== undefined ? { has_more: hasMore } : {}) };
  };
}

function chatListResponse(): unknown {
  return {
    [CHAT_LIST_EVENT]: [makeRawChat({ chatId: POLYGON_CHAT_ID, name: 'Дежурка', chatType: 'group_chat' })],
  };
}

function createHistoryDeps(hasMore?: boolean): { deps: ToolDeps; calls: RecordedCall[] } {
  const { events, inner } = buildEvents();
  const page = historyResponder(events, hasMore);
  return createDeps(
    (call) => (call.event === CHAT_LIST_EVENT ? chatListResponse() : page(call.payload)),
    inner,
  );
}

describe('форма запроса истории', () => {
  it('несёт направление, лимит и отключённые служебные события, а курсор только когда он есть', () => {
    expect(buildEventsHistoryPayload({ groupChatId: POLYGON_CHAT_ID, limit: 40, direction: 'backward' })).toEqual({
      group_chat_id: POLYGON_CHAT_ID,
      direction: 'backward',
      limit: 40,
      skip_non_affecting_rc: false,
    });

    /* Курсор это поле `sync_id`, а `skip_to_sync_id_event` только булев флаг перемотки */
    expect(
      buildEventsHistoryPayload({
        groupChatId: POLYGON_CHAT_ID,
        limit: 3,
        before: syncId(7),
        direction: 'forward',
      }),
    ).toEqual({
      group_chat_id: POLYGON_CHAT_ID,
      direction: 'forward',
      limit: 3,
      sync_id: syncId(7),
      skip_to_sync_id_event: true,
      skip_non_affecting_rc: false,
    });
  });
});

describe('страница истории', () => {
  it('сортирует от старых к новым и выбрасывает событие курсора', async () => {
    const { events, inner } = buildEvents();
    const { deps } = createDeps((call) => historyResponder(events)(call.payload), inner);

    const page = await fetchHistoryPage(deps, { chatId: POLYGON_CHAT_ID, limit: 3, before: syncId(7) });

    expect(page.events.map((event) => event['sync_id'])).toEqual([syncId(5), syncId(6)]);
    /* Насыщенность считается по сырой длине: иначе выброшенный курсор оборвал бы обход */
    expect(page.serverCount).toBe(3);
  });

  it('признак продолжения читается под обоими известными именами и не выдумывается', async () => {
    const { inner } = buildEvents();
    const named = await fetchHistoryPage(
      createDeps(() => ({ history: [], has_more_events: true }), inner).deps,
      { chatId: POLYGON_CHAT_ID, limit: 3 },
    );
    const silent = await fetchHistoryPage(createDeps(() => ({ history: [] }), inner).deps, {
      chatId: POLYGON_CHAT_ID,
      limit: 3,
    });

    expect(named.hasMore).toBe(true);
    expect(silent.hasMore).toBeUndefined();
  });
});

describe('get_history: курсор и признак продолжения', () => {
  it('отдаёт страницу от старых к новым и курсор по самому старому сообщению', async () => {
    const { deps } = createHistoryDeps();

    const result = await getHistory(deps, { chat: 'Дежурка', limit: 3 });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') {
      throw new Error('ожидалась успешная выдача');
    }

    expect(result.messages.map((message) => message.text)).toEqual([
      'сообщение дня 7',
      'сообщение дня 8',
      'сообщение дня 9',
    ]);
    expect(result.next_before).toBe(syncId(7));
    expect(result.chat_id).toBe(POLYGON_CHAT_ID);
    /* Обогащение аддитивно: база сообщения на месте, ключи чата добавлены сверху */
    expect(result.messages[0]?.chat_name).toBe('Дежурка');
    expect(result.messages[0]?.is_self_chat).toBe(false);
  });

  it('следующая страница по курсору не повторяет событие курсора', async () => {
    const { deps } = createHistoryDeps();

    const result = await getHistory(deps, { chat: 'Дежурка', limit: 3, before: syncId(7) });
    if (result.status !== 'ok') {
      throw new Error('ожидалась успешная выдача');
    }

    expect(result.messages.map((message) => message.message_id)).toEqual([syncId(5), syncId(6)]);
    expect(result.messages.map((message) => message.message_id)).not.toContain(syncId(7));
  });

  it('молчание сервера про продолжение не подменяется догадкой: ключа просто нет', async () => {
    const { deps } = createHistoryDeps();

    const result = await getHistory(deps, { chat: 'Дежурка', limit: 3 });
    if (result.status !== 'ok') {
      throw new Error('ожидалась успешная выдача');
    }

    expect(result.has_more).toBeUndefined();
    expect(Object.keys(result)).not.toContain('has_more');
  });

  it('присланный сервером признак продолжения уходит наружу', async () => {
    const { deps } = createHistoryDeps(true);

    const result = await getHistory(deps, { chat: 'Дежурка', limit: 3 });
    if (result.status !== 'ok') {
      throw new Error('ожидалась успешная выдача');
    }

    expect(result.has_more).toBe(true);
  });
});

describe('get_history: окно по датам', () => {
  it('нижняя граница включающая, верхняя исключающая, страницы добираются назад', async () => {
    const { deps, calls } = createHistoryDeps();

    const result = await getHistory(deps, {
      chat: 'Дежурка',
      limit: 3,
      from_date: '2026-09-05T00:00:00.000Z',
      to_date: '2026-09-08T00:00:00.000Z',
    });
    if (result.status !== 'ok') {
      throw new Error('ожидалась успешная выдача');
    }

    expect(result.messages.map((message) => message.text)).toEqual([
      'сообщение дня 5',
      'сообщение дня 6',
      'сообщение дня 7',
    ]);
    expect(result.next_before).toBe(syncId(5));
    /* Одной страницы на такое окно не хватает: добор обязан случиться */
    expect(calls.filter((call) => call.event === 'events_history').length).toBeGreaterThan(1);
  });

  it('after строго исключает саму метку и старше from_date по приоритету', async () => {
    const { deps } = createHistoryDeps();

    const result = await getHistory(deps, {
      chat: 'Дежурка',
      limit: 3,
      from_date: '2026-09-01T00:00:00.000Z',
      after: dayIso(5),
      to_date: '2026-09-08T00:00:00.000Z',
    });
    if (result.status !== 'ok') {
      throw new Error('ожидалась успешная выдача');
    }

    expect(result.messages.map((message) => message.text)).toEqual([
      'сообщение дня 6',
      'сообщение дня 7',
    ]);
  });

  it('добор страниц упирается в страховочный предел, а не листает историю до основания', async () => {
    const inner = new Map<string, Record<string, unknown>>();
    let issued = 0;
    const { deps, calls } = createDeps((call) => {
      if (call.event === CHAT_LIST_EVENT) {
        return chatListResponse();
      }
      const limit = call.payload['limit'] as number;
      const history = Array.from({ length: limit }, () => {
        issued += 1;
        return {
          sync_id: syncId(1000 + issued),
          group_chat_id: POLYGON_CHAT_ID,
          event_type: 'message_new',
          inserted_at: '2026-09-08T12:00:00.000Z',
          sender: MY_HUID,
          sender_key_id: 'sender-key-id',
          read_by: [],
          key: { key_id: 'recipient-key-id-a', key: 'подложная обёртка', algo: 'xsalsa20:xchacha20_aead_ietf' },
          payload: 'подложный шифротекст',
        };
      });
      return { history };
    }, inner);

    /* Окно, в которое не попадает ничего: накопитель не насыщается и обход шёл бы вечно */
    const result = await getHistory(deps, {
      chat: 'Дежурка',
      limit: 2,
      from_date: '2020-01-01T00:00:00.000Z',
      to_date: '2020-06-01T00:00:00.000Z',
    });
    if (result.status !== 'ok') {
      throw new Error('ожидалась успешная выдача');
    }

    expect(result.messages).toEqual([]);
    expect(result.next_before).toBeUndefined();
    expect(calls.filter((call) => call.event === 'events_history')).toHaveLength(MAX_HISTORY_PAGES);
  });
});

describe('get_history: отказ адресации', () => {
  it('незнакомый чат это статус отказа, а не пустая страница', async () => {
    const { deps } = createHistoryDeps();

    const result = await getHistory(deps, { chat: 'бухгалтерия' });

    expect(result.status).toBe('chat_not_found');
  });
});
