/**
 * Структурный лог в stderr.
 *
 * *** stdout НЕ ТРОГАЕТСЯ НИКОГДА. *** Он принадлежит MCP stdio-транспорту: там идёт поток
 * JSON-RPC, и любой посторонний байт, от строки лога до случайного вывода в консоль, делает
 * поток неразбираемым, то есть роняет сессию целиком.
 *
 * РЕДАКЦИЯ обязательна и покрывает две разные вещи:
 *  - секреты сессии (bearer, cookie, приватные ключи, подписи): их утечка компрометирует
 *    учётную запись, а логи переживают процесс и уезжают в баг-репорты;
 *  - содержимое переписки: это чужая приватная информация, и в логах диагностического
 *    инструмента ей не место ни на одном уровне.
 * Редактируются и ключи, и значения: секрет часто приезжает не отдельным полем, а внутри
 * строки (шифротекст в `payload`, токен в тексте ошибки), где проверка по имени ключа слепа.
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Переменная окружения уровня логирования */
export const LOG_LEVEL_ENV = 'CLOUDS_MESSENGER_MCP_LOG_LEVEL';

export const REDACTED = '[redacted]';

/**
 * Фрагменты имён полей, значения которых в лог не попадают никогда. Сравнение идёт
 * по ПОДСТРОКЕ и без учёта регистра: на проводе одно и то же едет как `key`, `sender_key_id`,
 * `privateKeys`, и точный список имён устаревал бы каждый раз, когда протокол добавляет поле.
 */
const REDACTED_KEY_PARTS = [
  'token',
  'bearer',
  'authorization',
  'cookie',
  'key',
  'body',
  'payload',
  'sign',
  'private',
  'text',
  'preview',
  'file_name',
  'secret',
  'password',
] as const;

/**
 * Длинная последовательность base64/JWT-алфавита это почти наверняка ключ, шифротекст,
 * подпись или токен, как бы ни называлось поле. Порог в 60 символов выбран так, чтобы
 * не задевать обычную диагностику: UUID (36) и имена событий короче.
 */
const SECRET_LIKE_SEQUENCE = /[A-Za-z0-9+/=_.-]{60,}/;

function isRedactedKey(key: string): boolean {
  const lower = key.toLowerCase();
  return REDACTED_KEY_PARTS.some((part) => lower.includes(part));
}

/** Строка с секретоподобной последовательностью заменяется целиком: длина остаётся для диагностики */
function scrubString(value: string): string {
  return SECRET_LIKE_SEQUENCE.test(value) ? `<redacted:${value.length}>` : value;
}

const MAX_DEPTH = 6;

function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) {
    return '[truncated]';
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1));
  }
  if (value instanceof Error) {
    /* Текст ошибки это строка из внешнего мира: в неё мог попасть токен или шифротекст */
    return { name: value.name, message: scrubString(value.message) };
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = isRedactedKey(key) ? REDACTED : redact(item, depth + 1);
    }
    return result;
  }
  if (typeof value === 'string') {
    return scrubString(value);
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return value;
}

function resolveLevel(raw: string | undefined): LogLevel {
  const candidate = raw?.toLowerCase();
  return LOG_LEVELS.includes(candidate as LogLevel) ? (candidate as LogLevel) : 'info';
}

/**
 * Поля записи. Намеренно `object`, а не `Record<string, unknown>`: у интерфейсов TS нет
 * неявной индексной сигнатуры, поэтому типизированный результат в `Record<string, unknown>`
 * не проходит, и каждый вызывающий был бы вынужден рассыпать объект спредом. Редакция
 * работает по значению и от типа не зависит.
 */
export type LogFields = object;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

export interface CreateLoggerOptions {
  level?: LogLevel;
  bindings?: LogFields;
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const level = options.level ?? resolveLevel(process.env[LOG_LEVEL_ENV]);
  const bindings = options.bindings ?? {};

  const log = (entry: LogLevel, message: string, fields?: LogFields): void => {
    if (LEVEL_ORDER[entry] < LEVEL_ORDER[level]) {
      return;
    }
    const record = {
      ts: new Date().toISOString(),
      level: entry,
      /*
       * Сообщение проходит ту же чистку, что и поля: текст записи собирается вызывающим,
       * и в него так же легко попадает токен из ответа сервера или кусок шифротекста.
       */
      msg: scrubString(message),
      ...(redact(bindings) as Record<string, unknown>),
      ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
    };
    process.stderr.write(`${JSON.stringify(record)}\n`);
  };

  return {
    debug: (message, fields) => log('debug', message, fields),
    info: (message, fields) => log('info', message, fields),
    warn: (message, fields) => log('warn', message, fields),
    error: (message, fields) => log('error', message, fields),
    child: (extra) => createLogger({ level, bindings: { ...bindings, ...extra } }),
  };
}
