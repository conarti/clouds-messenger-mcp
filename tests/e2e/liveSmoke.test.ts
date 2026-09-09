/**
 * Живой smoke на полигоне: боевые слои против настоящего сервера.
 *
 * НАБОР ПО УМОЛЧАНИЮ ПРОПУСКАЕТСЯ. Он ходит на реальную учётную запись, поэтому включается
 * только явным флагом окружения и в непрерывной интеграции не запускается.
 *
 * ТОЛЬКО ЧТЕНИЕ. Ни одного мутирующего вызова: набор можно гонять повторно, ничего не
 * меняя в переписке. Единственный живой round-trip отправки выполняется разовым скриптом
 * вручную и в этот набор не входит.
 *
 * ЖИВЫЕ ДАННЫЕ НАРУЖУ НЕ ВЫХОДЯТ. Ассерты идут по числам, булям и адресам; тексты, имена
 * чатов и имена людей не печатаются и не сохраняются, поэтому падение здесь сообщает
 * форму, а не содержимое чужой переписки. Сводка наблюдений печатается в конце и состоит
 * из счётчиков, признаков и адреса полигона.
 *
 * ПОДМЕН НЕТ НИ ОДНОГО. Ни vitest-мока, ни подложного сокета: авторизация поднимает
 * profile Playwright, кадры уходят в настоящий Phoenix, расшифровка идёт боевым libsodium.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlaywrightProfileAuth } from '../../src/auth/PlaywrightProfileAuth.js';
import { AuthKeyStore } from '../../src/auth/keyStore.js';
import { loadConfig } from '../../src/config/loadConfig.js';
import { SodiumCryptoService } from '../../src/crypto/service.js';
import type { ToolDeps } from '../../src/mcp/tools/deps.js';
import { getHistory, type GetHistoryOk } from '../../src/mcp/tools/getHistory.js';
import { getMessage } from '../../src/mcp/tools/getMessage.js';
import { getMessageContext } from '../../src/mcp/tools/getMessageContext.js';
import { listChats } from '../../src/mcp/tools/listChats.js';
import { listReactions } from '../../src/mcp/tools/listReactions.js';
import { SYSTEM_TOPIC } from '../../src/protocol/chatList.js';
import { PERSONAL_CHAT_TYPE } from '../../src/protocol/chatShape.js';
import { EVENT_INFO_EVENT, fetchEventBySyncId } from '../../src/protocol/eventInfo.js';
import {
  EVENTS_HISTORY_EVENT,
  buildEventsHistoryPayload,
  chatTopic,
} from '../../src/protocol/history.js';
import type { EnrichedMessage } from '../../src/protocol/enrichMessage.js';
import { UUID_PATTERN } from '../../src/protocol/messageShape.js';
import { fetchThreadList } from '../../src/protocol/threads.js';
import { HttpRestClient } from '../../src/transport/RestClient.js';
import { PhoenixReplyError, PhoenixWsClient } from '../../src/transport/ws/PhoenixClient.js';
import { asObject, stringOr } from '../../src/util/json.js';
import { createLogger } from '../../src/util/logger.js';

const E2E_ENV = 'CLOUDS_MESSENGER_MCP_E2E';
const PROFILE_DIR_ENV = 'CLOUDS_MESSENGER_MCP_PROFILE_DIR';
const CHAT_ENV = 'CLOUDS_MESSENGER_MCP_E2E_CHAT';

/** Бюджет набора: живой вход поднимает браузер, и десяти секунд по умолчанию ему мало */
const SUITE_TIMEOUT_MS = 180_000;

/** Страница истории полигона: чат с собой короткий, полсотни событий его накрывают */
const HISTORY_LIMIT = 50;

/**
 * Серверная заглушка имени личного чата. Сервер называет так ВСЕ личные чаты, поэтому
 * равенство ей означает, что справка о профилях не сработала.
 */
const SERVER_PERSONAL_CHAT_NAME = 'personal chat';

/** Лимит сырых проб формы ответа: спрашиваем ровно столько, сколько нужно на сверку краёв */
const PROBE_LIMIT = 3;

/**
 * Сводка живого прогона. Только счётчики, признаки и адреса: она печатается в вывод и
 * уезжает в артефакт исследования, поэтому ничего читаемого из переписки в ней нет.
 */
const observations: Record<string, unknown> = {};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(
      `предусловие живой пробы не выполнено: переменная окружения ${name} не задана. ` +
        `Набор запускается так: ${E2E_ENV}=1 ${PROFILE_DIR_ENV}=<каталог профиля> ` +
        `${CHAT_ENV}=<uuid полигона> npx vitest run tests/e2e/liveSmoke.test.ts`,
    );
  }
  return value.trim();
}

/** Сырые события страницы: сверка формы идёт до нормализации, иначе сверять нечего */
function rawHistory(response: unknown): Record<string, unknown>[] {
  const raw = asObject(response)?.['history'];
  return (Array.isArray(raw) ? raw : []).flatMap((entry) => {
    const event = asObject(entry);
    return event === undefined ? [] : [event];
  });
}

function insertedAt(event: Record<string, unknown>): string {
  return stringOr(event['inserted_at']) ?? '';
}

/** Порядок краёв страницы: от старых к новым, наоборот, либо неразличимо на одном событии */
function pageOrder(events: readonly Record<string, unknown>[]): string {
  const first = events[0];
  const last = events.at(-1);
  if (first === undefined || last === undefined || events.length < 2) {
    return 'unknown';
  }
  const head = insertedAt(first);
  const tail = insertedAt(last);
  if (head === tail) {
    return 'unknown';
  }
  return head < tail ? 'oldest_first' : 'newest_first';
}

function millis(message: EnrichedMessage): number {
  return message.timestamp === undefined ? Number.NaN : new Date(message.timestamp).getTime();
}

describe.runIf(process.env[E2E_ENV] === '1')(
  'живой smoke на полигоне',
  { timeout: SUITE_TIMEOUT_MS },
  () => {
    let deps: ToolDeps;
    let ws: PhoenixWsClient;
    let chatId: string;
    let history: GetHistoryOk;
    let messages: EnrichedMessage[];

    beforeAll(async () => {
      const profileDir = requireEnv(PROFILE_DIR_ENV);
      chatId = requireEnv(CHAT_ENV);

      const config = loadConfig({ paths: { profileDir } });
      const logger = createLogger({ level: 'error' });
      const auth = new PlaywrightProfileAuth({ config, logger });
      ws = new PhoenixWsClient({ auth, config, logger });
      const rest = new HttpRestClient({ auth, config, logger });
      const crypto = new SodiumCryptoService({ rest, logger });
      const keyStore = new AuthKeyStore(auth);
      deps = { ws, rest, auth, crypto, keyStore, config, logger };

      const page = await getHistory(deps, { chat: chatId, limit: HISTORY_LIMIT });
      if (page.status !== 'ok') {
        throw new Error(`история полигона недоступна: статус ${page.status}`);
      }
      history = page;
      messages = page.messages;
      observations['polygon_chat_id'] = chatId;
    }, SUITE_TIMEOUT_MS);

    afterAll(async () => {
      if (ws !== undefined) {
        await ws.close();
      }
      process.stderr.write(`e2e-observations ${JSON.stringify(observations)}\n`);
    }, SUITE_TIMEOUT_MS);

    it('list_chats отдаёт список, и полигон в нём есть', async () => {
      const listed = await listChats(deps, { limit: 200 });

      expect(listed.status).toBe('ok');
      expect(listed.total_chats).toBeGreaterThanOrEqual(1);
      expect(listed.chats.some((chat) => chat.chat_id === chatId)).toBe(true);

      const byKind: Record<string, number> = {};
      for (const chat of listed.chats) {
        byKind[chat.kind] = (byKind[chat.kind] ?? 0) + 1;
      }
      observations['chats_total'] = listed.total_chats;
      observations['chats_unread'] = listed.unread_chats;
      observations['chats_by_kind'] = byKind;
    });

    /*
     * Имена собеседников живут не в списке чатов, а в справке о профилях, и связка двух
     * источников проверяема только живьём. Наружу идут булевы: имя коллеги в выводе
     * проверки это те же персональные данные, что и в переписке.
     */
    it('личные чаты названы именами собеседников, а не серверной заглушкой', async () => {
      const listed = await listChats(deps, { limit: 200 });
      const personal = listed.chats.filter((chat) => chat.kind === PERSONAL_CHAT_TYPE);
      if (personal.length === 0) {
        throw new Error('в списке нет ни одного личного чата: предусловие пробы не выполнено');
      }

      const named = personal.some(
        (chat) => chat.name !== undefined && chat.name !== SERVER_PERSONAL_CHAT_NAME,
      );
      const addressed = personal.some((chat) => chat.peer_huid !== undefined);

      expect(named).toBe(true);
      expect(addressed).toBe(true);

      observations['personal_chats_any_named'] = named;
      observations['personal_chats_any_with_peer'] = addressed;
      observations['personal_chats_all_with_peer'] = personal.every(
        (chat) => chat.peer_huid !== undefined,
      );
    });

    it('get_history отдаёт расшифрованную страницу в неубывающем порядке', () => {
      expect(messages.length).toBeGreaterThanOrEqual(1);
      expect(messages.filter((message) => message.decrypt_error !== undefined)).toHaveLength(0);

      for (const message of messages.filter((entry) => entry.type === 'text')) {
        expect(message.text?.length ?? 0).toBeGreaterThan(0);
      }

      const stamps = messages.map(millis).filter((value) => !Number.isNaN(value));
      expect(stamps.length).toBe(messages.length);
      for (let index = 1; index < stamps.length; index += 1) {
        expect(stamps[index] ?? 0).toBeGreaterThanOrEqual(stamps[index - 1] ?? 0);
      }

      expect(UUID_PATTERN.test(history.next_before ?? '')).toBe(true);

      observations['history_count'] = messages.length;
      observations['history_decrypt_errors'] = 0;
      observations['history_text_count'] = messages.filter((entry) => entry.type === 'text').length;
      observations['history_has_more_key'] = Object.keys(history).includes('has_more');
      observations['history_has_more_value'] = history.has_more ?? 'absent';
    });

    it('get_message читает последнее сообщение по адресу', async () => {
      const newest = messages.at(-1);
      if (newest === undefined) {
        throw new Error('история полигона пуста: адресовать чтение нечем');
      }

      const payload = await getMessage(deps, { chat: chatId, message_id: newest.message_id });
      if (payload.status !== 'ok') {
        throw new Error(`адресное чтение отдало статус ${payload.status}`);
      }
      expect(payload.message.message_id).toBe(newest.message_id);
      expect(payload.message.decrypt_error).toBeUndefined();

      /* Путь чтения виден только слою протокола: инструмент отдаёт наружу лишь причину */
      const lookup = await fetchEventBySyncId(deps, {
        chatId,
        syncId: newest.message_id,
      });
      expect(lookup.event).toBeDefined();

      observations['event_info_via'] = lookup.via;
      observations['get_message_has_form_status'] = Object.keys(payload).includes('form_status');
    });

    it('границы окна по датам: верхняя исключающая, нижняя включающая', async () => {
      const newest = messages.at(-1);
      const stamp = newest?.timestamp;
      if (newest === undefined || stamp === undefined) {
        throw new Error('у самого свежего сообщения нет метки времени: границы проверить нечем');
      }

      const excluded = await getHistory(deps, {
        chat: chatId,
        limit: HISTORY_LIMIT,
        to_date: stamp,
      });
      if (excluded.status !== 'ok') {
        throw new Error(`верхняя граница отдала статус ${excluded.status}`);
      }
      expect(excluded.messages.map((entry) => entry.message_id)).not.toContain(newest.message_id);

      const included = await getHistory(deps, {
        chat: chatId,
        limit: HISTORY_LIMIT,
        from_date: stamp,
      });
      if (included.status !== 'ok') {
        throw new Error(`нижняя граница отдала статус ${included.status}`);
      }
      expect(included.messages.map((entry) => entry.message_id)).toContain(newest.message_id);

      observations['window_upper_excluded_count'] = excluded.messages.length;
      observations['window_lower_included_count'] = included.messages.length;
    });

    it('list_reactions отдаёт реакции сообщения, у которого они есть', async () => {
      const reacted = messages.find((entry) => (entry.reactions?.length ?? 0) > 0);
      if (reacted === undefined) {
        throw new Error(
          'в истории полигона нет сообщения с реакцией: предусловие пробы не выполнено',
        );
      }

      const payload = await listReactions(deps, { chat: chatId, message_id: reacted.message_id });
      if (payload.status !== 'ok') {
        throw new Error(`чтение реакций отдало статус ${payload.status}`);
      }
      expect(payload.reactions.length).toBeGreaterThanOrEqual(1);
      for (const reaction of payload.reactions) {
        expect(typeof reaction.emoji).toBe('string');
        expect(reaction.count).toBeGreaterThanOrEqual(1);
      }
      expect(payload.total).toBeGreaterThanOrEqual(payload.reactions.length);

      observations['reactions_kinds'] = payload.reactions.length;
      observations['reactions_total'] = payload.total;
      observations['reactions_has_form_status'] = Object.keys(payload).includes('form_status');
    });

    it('get_message_context строит окно вокруг предпоследнего сообщения', async () => {
      const pivot = messages.at(-2) ?? messages.at(-1);
      if (pivot === undefined) {
        throw new Error('история полигона пуста: центра окна нет');
      }

      const payload = await getMessageContext(deps, {
        chat: chatId,
        message_id: pivot.message_id,
        before_count: 2,
        after_count: 2,
      });
      if (payload.status !== 'ok') {
        throw new Error(`окно контекста отдало статус ${payload.status}`);
      }
      expect(Array.isArray(payload.before)).toBe(true);
      expect(Array.isArray(payload.after)).toBe(true);
      expect(payload.message?.message_id).toBe(pivot.message_id);
      expect(payload.pivot_message_id).toBe(pivot.message_id);

      observations['context_before_count'] = payload.before.length;
      observations['context_after_count'] = payload.after.length;
      observations['context_forward_worked'] = payload.after.length > 0;
    });

    it('список тредов полигона читается', async () => {
      const threads = await fetchThreadList(deps, chatId);

      expect(Array.isArray(threads)).toBe(true);

      /* Наружу идут только треды полигона: чужие чаты не читаются и не считаются */
      const polygonThreads = threads.filter((thread) => thread.chat_id === chatId);
      /*
       * Утверждение о ФОРМЕ, а не о количестве. Тредов у полигона может не быть вовсе, и
       * пустой список это законный исход пробы; а вот элемент без адреса-UUID либо с чужим
       * чатом означает расхождение с протоколом, и молчать о нём проверка не имеет права.
       */
      for (const thread of polygonThreads) {
        expect(thread.thread_id).toMatch(UUID_PATTERN);
        expect(thread.chat_id).toBe(chatId);
      }
      const known = new Set(messages.map((entry) => entry.message_id));
      const matched = polygonThreads.filter((thread) => known.has(thread.thread_id)).length;

      observations['threads_of_polygon'] = polygonThreads.length;
      observations['threads_narrowing_returned_foreign'] = threads.length > polygonThreads.length;
      observations['threads_matching_history_sync_id'] = matched;
    });

    it('сырая страница истории отдаёт свои поля, порядок и семантику курсора', async () => {
      const plain = await deps.ws.request<unknown>(
        chatTopic(chatId),
        EVENTS_HISTORY_EVENT,
        buildEventsHistoryPayload({
          groupChatId: chatId,
          limit: PROBE_LIMIT,
          direction: 'backward',
        }),
      );
      const plainKeys = Object.keys(asObject(plain) ?? {}).sort();
      expect(plainKeys.length).toBeGreaterThanOrEqual(1);
      expect(plainKeys).toContain('history');

      const newest = messages.at(-1);
      if (newest === undefined) {
        throw new Error('история полигона пуста: курсор проверить нечем');
      }
      const paged = await deps.ws.request<unknown>(
        chatTopic(chatId),
        EVENTS_HISTORY_EVENT,
        buildEventsHistoryPayload({
          groupChatId: chatId,
          limit: PROBE_LIMIT,
          before: newest.message_id,
          direction: 'backward',
        }),
      );
      const pagedEvents = rawHistory(paged);
      expect(pagedEvents.length).toBeGreaterThanOrEqual(1);
      const cursorIncluded = pagedEvents.some(
        (event) => stringOr(event['sync_id']) === newest.message_id,
      );

      /*
       * Адресное чтение проверяется сырым кадром: инструмент гасит отказ сервера и молча
       * уходит в историю, поэтому причина видна только здесь. Наружу идёт исход, не тело.
       */
      let addressedOutcome: string;
      try {
        const probe = await deps.ws.request<unknown>(SYSTEM_TOPIC, EVENT_INFO_EVENT, {
          sync_ids: [newest.message_id],
        });
        const body = asObject(probe);
        const keys = Object.keys(body ?? {}).sort();
        const carried = body?.['info'];
        const size = Array.isArray(carried) ? carried.length : -1;
        addressedOutcome =
          keys.length === 0 ? 'empty_response' : `keys:${keys.join(',')};info_length:${size}`;
      } catch (error) {
        addressedOutcome =
          error instanceof PhoenixReplyError
            ? `rejected:${error.code}`
            : `failed:${error instanceof Error ? error.name : 'unknown'}`;
      }

      observations['event_info_probe'] = addressedOutcome;
      observations['history_response_keys'] = plainKeys;
      observations['history_page_order'] = pageOrder(pagedEvents);
      observations['cursor_event_included'] = cursorIncluded;
      observations['probe_page_size'] = pagedEvents.length;
    });
  },
);
