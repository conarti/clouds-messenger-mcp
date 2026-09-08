/**
 * Кодек кадров Phoenix Channels (vsn 1.0.0, объектная форма).
 *
 * Кадр на проводе это JSON-объект `{topic, event, payload, ref}` (снято живьём, Фаза 0).
 * Ответ на запрос приходит событием `phx_reply`, где `payload` это `{status, response}`,
 * а `ref` эхом повторяет ref запроса. Кадры сервера без нашего ref (например `app_event`
 * в топике `system`) приезжают по тому же сокету и по форме неотличимы от ответа ничем,
 * кроме отсутствия ref и другого имени события.
 *
 * Разбор устойчив к мусору намеренно: сокет это внешний мир, и один неразобранный кадр
 * не имеет права ронять транспорт вместе со всеми запросами в полёте. Поэтому неудача
 * разбора возвращается значением с причиной, а не исключением: причина уходит в лог и
 * даёт шанс увидеть смену формы протокола, вместо того чтобы утонуть в catch.
 */

/** Кадр Phoenix. `ref` равен null у кадров, инициированных сервером */
export interface PhoenixFrame {
  topic: string;
  event: string;
  payload: unknown;
  ref: number | null;
}

/** Ответ разбора: либо кадр, либо причина отказа для лога */
export type DecodeResult = { ok: true; frame: PhoenixFrame } | { ok: false; reason: string };

/** Событие ответа Phoenix на запрос клиента */
export const REPLY_EVENT = 'phx_reply';

/** Топик служебных кадров: authenticate и heartbeat */
export const PHOENIX_TOPIC = 'phoenix';
export const AUTHENTICATE_EVENT = 'authenticate';
export const HEARTBEAT_EVENT = 'heartbeat';

export interface ReplyPayload {
  status: 'ok' | 'error';
  response: unknown;
  /** Строковый код отказа из `response.error`, наблюдался `invalid_keys` */
  errorCode?: string;
}

export function encodeFrame(frame: PhoenixFrame): string {
  return JSON.stringify({
    topic: frame.topic,
    event: frame.event,
    payload: frame.payload,
    ref: frame.ref,
  });
}

/** Длина среза сырого кадра в диагнозе: достаточно, чтобы узнать форму, мало, чтобы утащить тело */
const REASON_SNIPPET_LENGTH = 80;

export function decodeFrame(raw: string): DecodeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: `кадр не является JSON: ${raw.slice(0, REASON_SNIPPET_LENGTH)}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: `кадр не является объектом: ${typeof parsed}` };
  }

  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate['topic'] !== 'string') {
    return { ok: false, reason: 'кадр без строкового topic' };
  }
  if (typeof candidate['event'] !== 'string') {
    return { ok: false, reason: 'кадр без строкового event' };
  }

  return {
    ok: true,
    frame: {
      topic: candidate['topic'],
      event: candidate['event'],
      payload: candidate['payload'],
      /* Нечисловой ref приравнивается к его отсутствию: корреляция идёт только по числу */
      ref: typeof candidate['ref'] === 'number' ? candidate['ref'] : null,
    },
  };
}

export function isReply(frame: PhoenixFrame): boolean {
  return frame.event === REPLY_EVENT;
}

/**
 * Достаёт статус ответа. Всё, что не `status:"ok"`, считается отказом: молчаливо
 * трактовать незнакомый статус как успех означало бы отдать вызывающему пустой ответ
 * вместо ошибки, а это худший вид поломки.
 */
export function parseReply(frame: PhoenixFrame): ReplyPayload {
  const payload = frame.payload;
  if (payload === null || typeof payload !== 'object') {
    return { status: 'error', response: payload };
  }

  const record = payload as Record<string, unknown>;
  const response = record['response'];
  if (record['status'] === 'ok') {
    return { status: 'ok', response };
  }

  const errorCode =
    response !== null && typeof response === 'object'
      ? (response as Record<string, unknown>)['error']
      : undefined;

  return {
    status: 'error',
    response,
    ...(typeof errorCode === 'string' ? { errorCode } : {}),
  };
}
