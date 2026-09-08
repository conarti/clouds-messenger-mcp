/**
 * Confirm-токен необратимой мутации: память о черновике, а не полномочие.
 *
 * ЗАЧЕМ ДВА ШАГА. Потребитель инструмента это языковая модель, а отправка необратима:
 * отозвать сообщение у собеседника нельзя. Первый вызов ничего не отправляет и отдаёт
 * превью вместе с токеном, второй предъявляет токен обратно. Между шагами модель обязана
 * увидеть, ЧТО и КУДА уходит, и это единственный доступный серверу способ спросить: своего
 * канала к человеку у него нет.
 *
 * ТОКЕН НЕ ПОДПИСАН, И ЭТО ОСОЗНАННО. Подпись защищала бы от подделки, но подделка ничего
 * не даёт. На шаге подтверждения чат резолвится ЗАНОВО, отпечаток нагрузки считается
 * ЗАНОВО, и оба сверяются с токеном; отправка идёт в проверенный чат и той нагрузкой,
 * которую предъявил вызывающий. Подделав токен, можно добиться ровно того же, чего можно
 * добиться честным черновиком: своя нагрузка уедет в свой чат. Токен несёт эталон для
 * сравнения, а не право на действие, поэтому шифровать и подписывать в нём нечего.
 *
 * НАГРУЗКИ В ТОКЕНЕ НЕТ, ТОЛЬКО ЕЁ ОТПЕЧАТОК. Токен уходит в контекст модели и приезжает
 * оттуда обратно: текст сообщения внутри него означал бы, что содержимое переписки возится
 * туда-сюда и что у отправляемого появился второй источник истины.
 *
 * ОТПЕЧАТОК ДОМЕН-СЕПАРИРОВАН ОПЕРАЦИЕЙ: `sha256(op + ':' + payload)`. Сегодня операция
 * одна, но отпечаток одинаковой нагрузки двух разных операций обязан различаться и на
 * уровне хэша, а не только сверкой поля `op`: иначе первая же вторая мутация принесёт
 * возможность предъявить чужой токен при случайном совпадении полей.
 *
 * ИДЕМПОТЕНТНОСТЬ ЗДЕСЬ ЛОКАЛЬНАЯ. Серверный дедуп по повторному `sync_id` живой пробой
 * НЕ проверялся (Фаза 0 повторяла отправку новым `sync_id`), поэтому обещать его нельзя.
 * Повтор подтверждения тем же токеном закрывается памятью результата: израсходованный
 * токен отдаёт запомненный ответ, а второй кадр никуда не уходит. Память ограничена
 * сверху, потому что это защита от повтора в пределах сессии, а не журнал операций.
 */
import { createHash } from 'node:crypto';

/**
 * Операции, идущие через подтверждение. Сегодня одна: критерий отнесения это
 * необратимость последствия тем же набором инструментов, а читающие вызовы и обратимые
 * мутации подтверждения не требуют. Дешёвое подтверждение обесценивает дорогое.
 */
export type ConfirmOp = 'send';

/** Начинка токена: адресат, отпечаток нагрузки и идентификатор отправки */
export interface DraftToken {
  op: ConfirmOp;
  /** РЕЗОЛВНУТЫЙ адрес чата, а не строка запроса: сверяется с заново резолвнутым */
  chat_id: string;
  /** Отпечаток нагрузки; самой нагрузки в токене нет */
  fingerprint: string;
  /**
   * Идентификатор отправки, придуманный на шаге черновика. Он едет в кадре и остаётся
   * одним и тем же при повторе подтверждения: заново сгенерированный означал бы, что
   * повтор это НОВАЯ отправка, даже если бы сервер умел дедуплицировать.
   */
  sync_id: string;
}

/** Причины отказа подтверждения: машинно-читаемый словарь, закрытый и исчерпывающий */
export type ConfirmRejectReason =
  | 'missing_token'
  | 'malformed_token'
  | 'op_mismatch'
  | 'chat_mismatch'
  | 'fingerprint_mismatch';

/** Подтверждение отвергнуто. `reason` для машины, текст для человека */
export class ConfirmRejectedError extends Error {
  readonly reason: ConfirmRejectReason;
  readonly detail: string;

  constructor(reason: ConfirmRejectReason, detail: string) {
    super(`подтверждение отвергнуто (${reason}): ${detail}`);
    this.name = 'ConfirmRejectedError';
    this.reason = reason;
    this.detail = detail;
  }
}

/** Отпечаток нагрузки, домен-сепарированный операцией */
export function fingerprint(op: ConfirmOp, payload: string): string {
  return createHash('sha256').update(`${op}:${payload}`, 'utf8').digest('hex');
}

/** Упаковка полей, а не защищённый носитель полномочий: см. шапку модуля */
export function encodeToken(token: DraftToken): string {
  return Buffer.from(JSON.stringify(token), 'utf8').toString('base64url');
}

/**
 * Разбор токена. Мусор это ШТАТНЫЙ случай, а не авария: модель предъявляет строку из
 * своего контекста, и она вполне может оказаться обрезанной или чужой. Поэтому здесь
 * `undefined`, а решение об отказе с внятной причиной принимает вызывающий.
 *
 * ЗНАЧЕНИЕ `op` ЗДЕСЬ НЕ СВЕРЯЕТСЯ, проверяется только его наличие строкой. Токен чужой
 * операции обязан доехать до сверки и получить свою причину отказа: свести его к «мусору»
 * значило бы отчитаться о предъявлении токена другой мутации так же, как об обрезанной
 * строке, то есть увести диагностику в сторону на самом интересном классе расхождений.
 */
export function decodeToken(raw: string): DraftToken | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (parsed === null || typeof parsed !== 'object') {
      return undefined;
    }
    const fields = parsed as Record<string, unknown>;
    const op = fields['op'];
    const chatId = fields['chat_id'];
    const payloadFingerprint = fields['fingerprint'];
    const syncId = fields['sync_id'];
    if (
      typeof op !== 'string' ||
      op.length === 0 ||
      typeof chatId !== 'string' ||
      typeof payloadFingerprint !== 'string' ||
      typeof syncId !== 'string'
    ) {
      return undefined;
    }
    return {
      op: op as ConfirmOp,
      chat_id: chatId,
      fingerprint: payloadFingerprint,
      sync_id: syncId,
    };
  } catch {
    return undefined;
  }
}

export interface VerifyConfirmInput {
  /** Операция вызывающего инструмента: сверяется с операцией токена */
  op: ConfirmOp;
  /** Сырой токен, как он пришёл от вызывающего */
  token: string | undefined;
  /** ЗАНОВО резолвнутый адрес чата */
  chatId: string;
  /** ЗАНОВО посчитанный отпечаток нагрузки */
  fingerprint: string;
}

/**
 * Полная перепроверка подтверждения. Возвращает разобранный токен, а при любом расхождении
 * бросает {@link ConfirmRejectedError} и НИЧЕГО не отправляет: решение остаётся за
 * вызывающим до момента отправки.
 *
 * Порядок проверок значим. Операция сверяется раньше чата, иначе предъявление токена одной
 * мутации другой при случайном совпадении чата отчиталось бы как расхождение чата и увело
 * бы диагностику в сторону. При расхождении чата «более правильный» не выбирается: ни один
 * из двух не правильнее, расхождение означает, что подтверждали не это.
 */
export function verifyConfirm(input: VerifyConfirmInput): DraftToken {
  const raw = input.token;
  if (raw === undefined || raw.length === 0) {
    throw new ConfirmRejectedError(
      'missing_token',
      'подтверждение требует confirm_token, полученный на шаге черновика',
    );
  }
  const token = decodeToken(raw);
  if (token === undefined) {
    throw new ConfirmRejectedError('malformed_token', 'confirm_token не разобран');
  }
  if (token.op !== input.op) {
    throw new ConfirmRejectedError(
      'op_mismatch',
      `токен операции «${token.op}» предъявлен операции «${input.op}»`,
    );
  }
  if (token.chat_id !== input.chatId) {
    throw new ConfirmRejectedError(
      'chat_mismatch',
      'запрос chat резолвится в другой чат, чем на шаге черновика',
    );
  }
  if (token.fingerprint !== input.fingerprint) {
    throw new ConfirmRejectedError(
      'fingerprint_mismatch',
      'нагрузка отличается от подтверждённой на шаге черновика',
    );
  }
  return token;
}

/** Потолок памяти результатов: защита от повтора в пределах сессии, а не журнал */
export const CONFIRM_MEMORY_LIMIT = 200;

/**
 * Израсходованные токены и их результаты.
 *
 * Повтор подтверждения НЕ отвергается, а отдаёт запомненный результат. Отказ на повторе
 * заставил бы модель, потерявшую ответ по таймауту, решать, отправилось ли что-нибудь;
 * повтор результата отвечает на этот вопрос однозначно.
 *
 * Вытеснение по порядку вставки. Вытесненный токен означает, что повтор уйдёт на сервер
 * второй раз: серверный дедуп по повторному `sync_id` живой пробой не подтверждён, поэтому
 * потолок выбран с запасом относительно длины разумной сессии, а не «на всякий случай».
 */
export class ConfirmMemory {
  private readonly resultByToken = new Map<string, unknown>();

  constructor(private readonly limit: number = CONFIRM_MEMORY_LIMIT) {}

  remember(token: string, result: unknown): void {
    this.resultByToken.set(token, result);
    for (const oldest of this.resultByToken.keys()) {
      if (this.resultByToken.size <= this.limit) {
        break;
      }
      this.resultByToken.delete(oldest);
    }
  }

  recall<T>(token: string): T | undefined {
    return this.resultByToken.get(token) as T | undefined;
  }

  /** Сброс: нужен проверкам, чтобы состояние не текло между случаями */
  clear(): void {
    this.resultByToken.clear();
  }

  get size(): number {
    return this.resultByToken.size;
  }
}

/**
 * Общая память процесса. Живёт модулем, а не полем зависимостей, потому что защищает от
 * повтора в пределах сессии, а сессия здесь одна на процесс.
 */
export const confirmMemory = new ConfirmMemory();
