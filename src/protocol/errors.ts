/**
 * Ошибки трёх слоёв, склеенные в одну форму с ТЕГОМ СЛОЯ.
 *
 * Тег обязателен, потому что один и тот же код в разных слоях значит разное: `not_found`
 * от Phoenix это отказ прикладного события, а `404` от REST это отсутствие ресурса KDC.
 * Агент, увидевший код без слоя, чинит не то место.
 *
 * Неизвестный код не проглатывается и не переименовывается: он доезжает наружу как есть,
 * а текст прямо говорит, что кода нет в справочнике. Молчаливое сведение чужого кода к
 * своему словарю превращает новый отказ сервера в старый диагноз.
 *
 * ИСХОДНЫЙ ТЕКСТ СОХРАНЯЕТСЯ ВСЕГДА, без исключений для «понятных» классов. Правило без
 * исключений проверяется одной проверкой на все классы разом, а правило с исключениями
 * проверяется по классу, и первый же новый класс отказа приезжает сюда необработанным.
 */
import { AuthError } from '../auth/AuthProvider.js';
import { KeyNotFoundError } from '../auth/keyStore.js';
import { KeyResolutionError } from '../crypto/keys.js';
import { DecryptError, type DecryptStage } from '../crypto/decrypt.js';
import { RateLimitError, RestError } from '../transport/RestClient.js';
import { PhoenixReplyError, WsClosedError, WsTimeoutError } from '../transport/ws/PhoenixClient.js';

export type ErrorLayer = 'phoenix' | 'rest' | 'client';

/**
 * Коды обрыва и молчания сокета. Они НАШИ, а не серверные: сервер в этих случаях не
 * присылает кода вовсе, потому что не присылает ничего. Слой при этом всё равно phoenix,
 * потому что чинится отказ там же, где случился: соединением, а не расшифровкой и не KDC.
 */
export const TRANSPORT_CLOSED_CODE = 'transport_closed';
export const TRANSPORT_TIMEOUT_CODE = 'transport_timeout';

/** Код лимита частоты: у REST он приезжает статусом 429, у Phoenix прикладным кодом */
export const RATE_LIMITED_CODE = 'rate_limited';

/**
 * Расшифровки прикладных кодов Phoenix. Сам по себе код диагностически пуст: `invalid_keys`
 * ничего не говорит про то, что список получателей берётся из чата, а не из профиля, хотя
 * это ровно та ошибка, ради которой код и приходит (живая проба Фазы 0).
 *
 * Справочник закрытым не объявлен: код вне его наружу уедет с пометкой «unknown code», и
 * это единственная правильная реакция на незнакомое значение чужого сервера.
 */
const PHOENIX_HINTS: Record<string, string> = {
  invalid_keys:
    'обёртка контент-ключа собрана не на те ключи получателей: список получателей приезжает ' +
    'вместе с чатом, перечитайте список чатов и повторите',
  unauthorized: 'сессия отвергнута сервером: токен протух либо профиль устарел, переавторизуйтесь',
  not_found: 'сервер не нашёл сущность по этому адресу: сверьте идентификаторы чата и сообщения',
  forbidden: 'нет прав на эту операцию в этом чате',
  timeout: 'сервер не успел обработать запрос: повторите позже',
  [RATE_LIMITED_CODE]:
    'сервер просит притормозить: повторы уже выдержали паузу и не помогли, следующий вызов ' +
    'имеет смысл делать заметно позже',
  too_many_requests:
    'сервер считает частоту вызовов чрезмерной: то же, что rate_limited, другим именем',
  [TRANSPORT_CLOSED_CODE]:
    'соединение закрылось раньше ответа, а бюджет повторов исчерпан: запрос до сервера мог и ' +
    'дойти, поэтому повторять его вслепую нельзя ничему, кроме чтения',
  [TRANSPORT_TIMEOUT_CODE]:
    'ответ не пришёл в отведённый срок: соединение живо, молчит именно событие, и повтор ' +
    'имеет смысл только для чтения',
};

export interface MessengerErrorInit {
  layer: ErrorLayer;
  /** Код как он приехал: строка сервера, HTTP-статус либо имя класса клиентского отказа */
  code: string;
  /** Подробность, которую знает вызывающий: топик и событие, срез тела, текст исходной ошибки */
  detail?: string;
}

/** Заглушка подробности: пустой хвост после двоеточия выглядел бы потерянным текстом */
const NO_DETAIL = 'без подробностей';

export class MessengerError extends Error {
  readonly layer: ErrorLayer;
  readonly code: string;
  readonly detail: string;
  /** Код есть в справочнике слоя. false означает, что наружу уехало сырое значение сервера */
  readonly known: boolean;

  constructor(init: MessengerErrorInit) {
    const hint = init.layer === 'phoenix' ? PHOENIX_HINTS[init.code] : undefined;
    const detail = [hint, init.detail].filter((part) => part !== undefined && part.length > 0).join('; ');
    const resolvedDetail = detail.length > 0 ? detail : NO_DETAIL;
    const known = init.layer !== 'phoenix' || hint !== undefined;
    super(
      known
        ? `[${init.layer}] ${init.code}: ${resolvedDetail}`
        : `[${init.layer}] unknown code: ${init.code}: ${resolvedDetail}`,
    );
    this.name = 'MessengerError';
    this.layer = init.layer;
    this.code = init.code;
    this.detail = resolvedDetail;
    this.known = known;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Подробность слоя плюс исходный текст: собственный текст ошибки не теряется никогда */
function detailOf(error: unknown, ...parts: readonly string[]): string {
  return [...parts, messageOf(error)].filter((part) => part.length > 0).join('; ');
}

/**
 * Код по шагу расшифровки. Шаги разведены, потому что чинятся разным: обёртка это не тот
 * ключ отправителя, тело это расхождение связанных данных, json это удавшаяся расшифровка
 * не события. Общий код `decrypt` заставлял бы читать текст, чтобы понять, что случилось.
 *
 * Коды выписаны целиком, а не собраны шаблоном: собранное имя не находится грепом, и
 * читатель отчёта об ошибке не может найти в исходниках место, откуда оно взялось.
 */
const DECRYPT_CODES: Record<DecryptStage, string> = {
  wrap: 'decrypt_wrap',
  body: 'decrypt_body',
  json: 'decrypt_json',
};

/** Код по виду отказа авторизации: bearer лечится сменой токена, protocol не лечится ею */
const AUTH_CODES: Record<AuthError['kind'], string> = {
  bearer: 'auth_bearer',
  protocol: 'auth_protocol',
};

/** Код клиентского отказа. Имя класса наружу не отдаётся, отдаётся код слоя */
function clientCodeOf(error: unknown): string | undefined {
  if (error instanceof DecryptError) {
    return DECRYPT_CODES[error.stage];
  }
  if (error instanceof KeyNotFoundError) {
    return 'key_not_found';
  }
  if (error instanceof KeyResolutionError) {
    return 'key_resolution';
  }
  if (error instanceof AuthError) {
    return AUTH_CODES[error.kind];
  }
  return undefined;
}

/**
 * Любая ошибка в одну форму с тегом слоя.
 *
 * Ошибка, уже разобранная слоем, возвращается как есть: повторный разбор навесил бы
 * второй тег и превратил бы `[phoenix] invalid_keys` в `[client] unexpected`.
 *
 * Порядок проверок значим дважды: `RateLimitError` наследует `RestError`, а `WsTimeoutError`
 * несёт топик и событие, которых у `WsClosedError` нет.
 */
export function describeError(error: unknown): MessengerError {
  if (error instanceof MessengerError) {
    return error;
  }
  if (error instanceof PhoenixReplyError) {
    return new MessengerError({
      layer: 'phoenix',
      code: error.code,
      detail: detailOf(error, `топик ${error.topic}, событие ${error.event}`),
    });
  }
  if (error instanceof WsTimeoutError) {
    return new MessengerError({
      layer: 'phoenix',
      code: TRANSPORT_TIMEOUT_CODE,
      detail: detailOf(error, `топик ${error.topic}, событие ${error.event}`),
    });
  }
  if (error instanceof WsClosedError) {
    return new MessengerError({
      layer: 'phoenix',
      code: TRANSPORT_CLOSED_CODE,
      detail: detailOf(error),
    });
  }
  if (error instanceof RateLimitError) {
    /* Величина паузы это единственное, что отличает эту просьбу от прочих отказов REST */
    return new MessengerError({
      layer: 'rest',
      code: RATE_LIMITED_CODE,
      detail: detailOf(error, `пауза ${error.pauseMs}мс`),
    });
  }
  if (error instanceof RestError) {
    return new MessengerError({
      layer: 'rest',
      /* Код тела старше номера статуса: он точнее, а статус остаётся в подробности */
      code: error.code ?? String(error.status),
      detail: detailOf(error, `HTTP ${error.status}: ${error.bodySnippet}`),
    });
  }
  const clientCode = clientCodeOf(error);
  return new MessengerError({
    layer: 'client',
    code: clientCode ?? 'unexpected',
    detail: detailOf(error),
  });
}

/**
 * То же приведение под именем, читающимся как приведение.
 *
 * Заведено для проверок: они утверждают про ФОРМУ ошибки, а не про её описание, и вызов
 * `describeError` в утверждении читался бы как проверка текста, а не типа.
 */
export function toMessengerError(error: unknown): MessengerError {
  return describeError(error);
}
