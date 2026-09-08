/**
 * `get_poll`: опрос, приложенный к сообщению.
 *
 * ФОРМА НЕ ПОДТВЕРЖДЕНА ЖИВЬЁМ, И ЭТО НЕ ЛЕНЬ, А УСТРОЙСТВО МЕССЕНДЖЕРА: опрос нельзя
 * завести в личном чате, а живой полигон это чат с собой (findings.md, P3). Поэтому и
 * признак опроса, и состав его полей взяты из бандла веб-клиента, а выдача несёт
 * `form_status:'unconfirmed'` во ВСЕХ исходах, включая отрицательный: «это не опрос» здесь
 * тоже вывод из неподтверждённого признака, и выдавать его за факт нельзя.
 *
 * НЕПРИМЕНИМОСТЬ ОТЛИЧАЕТСЯ ОТ ОТСУТСТВИЯ. В личном чате и в чате с собой опроса не может
 * быть в принципе, и это отдельный статус: агент, получивший `not_a_poll` там, где опрос
 * невозможен, пошёл бы искать ошибку в адресе сообщения.
 */
import { resolveChat } from '../../chat/resolveChat.js';
import { resolveFailure, type ChatResolveFailure } from '../../chat/resolveFailure.js';
import { decryptHistoryEvents } from '../../protocol/decryptHistory.js';
import { fetchEventBySyncId } from '../../protocol/eventInfo.js';
import { extractMyVotes, extractPoll, supportsPolls } from '../../protocol/poll.js';
import {
  messageNotFound,
  messageNotReadable,
  type MessageNotFound,
  type MessageNotReadable,
} from './messageFailure.js';
import type { ToolDeps } from './deps.js';

export interface GetPollInput {
  chat: string;
  message_id: string;
}

export interface GetPollOk {
  status: 'ok';
  chat_id: string;
  message_id: string;
  /** Собственный адрес опроса: им адресуется голосование, и это НЕ message_id */
  poll_id?: string;
  /** Поля опроса как они приехали, без нормализации */
  poll: Record<string, unknown>;
  /** Свои голоса, если сервер их прислал */
  my_votes?: unknown[];
  form_status: 'unconfirmed';
  form_note: string;
}

export interface NotAPoll {
  status: 'not_a_poll';
  reason: string;
  form_status: 'unconfirmed';
  form_note: string;
}

export interface PollNotApplicable {
  status: 'not_applicable';
  reason: string;
  next_step: string;
}

export type GetPollResult =
  | GetPollOk
  | NotAPoll
  | PollNotApplicable
  | MessageNotFound
  | MessageNotReadable
  | ChatResolveFailure;

const FORM_NOTE =
  'опрос живой пробой не наблюдался: и признак опроса в сообщении, и состав его полей взяты ' +
  'из бандла веб-клиента. Отдельной ручки чтения опроса у сервера нет, опрос приезжает внутри ' +
  'сообщения, а изменения счётчиков голосов приходят отдельными событиями и здесь не видны';

const NOT_A_POLL_NOTE =
  'признак опроса неподтверждён: отрицательный ответ означает, что в сообщении не нашлось ни ' +
  'типа опроса, ни его адреса в той форме, какую описывает бандл веб-клиента';

const NOT_APPLICABLE_NEXT_STEP =
  'ищите опрос в групповом чате: возьмите его chat_id из выдачи list_chats';

export async function getPoll(deps: ToolDeps, input: GetPollInput): Promise<GetPollResult> {
  const resolved = await resolveChat(deps, input.chat);
  if (resolved.kind !== 'resolved') {
    return resolveFailure(resolved);
  }
  const chat = resolved.chat;

  if (!supportsPolls(chat.kind)) {
    return {
      status: 'not_applicable',
      reason: `опросы доступны только в групповых чатах, а чат ${chat.chat_id} имеет вид ${chat.kind}`,
      next_step: NOT_APPLICABLE_NEXT_STEP,
    };
  }

  const lookup = await fetchEventBySyncId(deps, { chatId: chat.chat_id, syncId: input.message_id });
  const event = lookup.event;
  if (event === undefined) {
    return messageNotFound(`в чате ${chat.chat_id} нет события с sync_id ${input.message_id}`);
  }

  const [decrypted] = await decryptHistoryEvents(deps, [event]);
  if (decrypted?.inner === undefined) {
    /* Опрос лежит в зашифрованном теле: нерасшифрованное сообщение это незнание, а не «не опрос» */
    return messageNotReadable(
      decrypted?.error ?? `тело события ${input.message_id} не разобрано, опрос в нём не виден`,
    );
  }

  const poll = extractPoll(decrypted.inner);
  if (poll === undefined) {
    return {
      status: 'not_a_poll',
      reason: `сообщение ${input.message_id} не несёт признаков опроса`,
      form_status: 'unconfirmed',
      form_note: NOT_A_POLL_NOTE,
    };
  }

  const myVotes = extractMyVotes(event);
  deps.logger.debug('get_poll: опрос прочитан', { chatId: chat.chat_id, myVotes: myVotes.length });

  return {
    status: 'ok',
    chat_id: chat.chat_id,
    message_id: input.message_id,
    ...(poll.poll_id !== undefined ? { poll_id: poll.poll_id } : {}),
    poll: poll.raw,
    ...(myVotes.length > 0 ? { my_votes: myVotes } : {}),
    form_status: 'unconfirmed',
    form_note: FORM_NOTE,
  };
}
