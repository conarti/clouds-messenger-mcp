import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Config } from './config/types.js';
import { downloadAttachment } from './mcp/tools/downloadAttachment.js';
import { getHistory } from './mcp/tools/getHistory.js';
import { getMessage } from './mcp/tools/getMessage.js';
import { getMessageContext, DEFAULT_CONTEXT_WINDOW } from './mcp/tools/getMessageContext.js';
import { getPoll } from './mcp/tools/getPoll.js';
import { getThread, DEFAULT_THREAD_LIMIT } from './mcp/tools/getThread.js';
import { listChats } from './mcp/tools/listChats.js';
import { listReactions } from './mcp/tools/listReactions.js';
import { SEARCH_TOOL_DEFINITION, search } from './mcp/tools/search.js';
import { TEXT_MAX_LENGTH, sendMessage } from './mcp/tools/sendMessage.js';
import type { ToolDeps } from './mcp/tools/deps.js';
import { describeError } from './protocol/errors.js';
import { UUID_PATTERN } from './protocol/messageShape.js';
import { asObject, stringOr } from './util/json.js';
import type { Logger } from './util/logger.js';

export const SERVER_NAME = 'clouds-messenger-mcp';

/**
 * Версия читается из package.json, а не дублируется строкой: одно число истины на релиз.
 *
 * Путь резолвится от самого модуля. В тестах (vitest гоняет TS из `src`) это
 * `src/server.ts` -> `../package.json`, в сборке `dist/server.js` -> `../package.json`:
 * корень один и тот же, потому что `tsc` зеркалит `src` в `dist` один в один
 * (`rootDir: "src"`, `outDir: "dist"`).
 */
function readServerVersion(): string {
  const packageJsonUrl = new URL('../package.json', import.meta.url);
  const packageJson = asObject(JSON.parse(readFileSync(packageJsonUrl, 'utf8'))) ?? {};
  return stringOr(packageJson['version']) ?? '0.0.0';
}

export const SERVER_VERSION = readServerVersion();

/** Инструменты, которые сервер обязан выставлять в первой версии */
export const TOOL_NAMES = [
  'list_chats',
  'get_history',
  'get_message',
  'get_message_context',
  'search',
  'get_thread',
  'get_poll',
  'list_reactions',
  'download_attachment',
  'send_message',
] as const;

/**
 * Категории инструментов: они ОБЯЗАНЫ покрывать канонический список целиком и не
 * пересекаться. Ради этого категории и заведены отдельным объявлением: инструмент,
 * забытый при классификации, выпадает из объединения, и проверка покрытия падает, а не
 * молча считает необратимую операцию читающей.
 *
 * `download_attachment` лежит среди читающих осознанно. Он не помечен read-only, потому
 * что пишет файл на диск, но переписки он не меняет, а подтверждения требует ровно то,
 * что необратимо для собеседника: дешёвое подтверждение обесценивает дорогое.
 */
export const READ_TOOLS = [
  'list_chats',
  'get_history',
  'get_message',
  'get_message_context',
  'search',
  'get_thread',
  'get_poll',
  'list_reactions',
  'download_attachment',
] as const;

/** Двухшаговые инструменты: необратимое действие подтверждается отдельным вызовом */
export const CONFIRM_TOOLS = ['send_message'] as const;

export interface CreateServerOptions {
  config: Config;
  logger: Logger;
  /** Транспорты, авторизация и крипто: без них не работает ни один инструмент */
  deps: ToolDeps;
}

/** Успешный результат: структурный JSON, его потребитель тут машина, а не человек */
function jsonResult(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

/**
 * Отказ инструмента в MCP-ошибку.
 *
 * Задача ровно одна: не потерять ошибку и не выдать её за пустую выдачу. Разбор слоёв
 * делает `protocol/errors`, поэтому наружу уезжает текст с ТЕГОМ СЛОЯ: без него код вроде
 * `not_found` неинтерпретируем, потому что в разных слоях он значит разное.
 */
function errorResult(tool: string, error: unknown, logger: Logger): CallToolResult {
  const described = describeError(error);
  logger.error('вызов инструмента не удался', {
    tool,
    layer: described.layer,
    code: described.code,
    known: described.known,
  });
  return { isError: true, content: [{ type: 'text', text: `${tool}: ${described.message}` }] };
}

/**
 * Сборка сервера. Ввода-вывода нет: ни сети, ни браузера, ни чтения профиля.
 *
 * Регистрируются инструменты чтения. Дефолты лимитов печатаются в описаниях параметров
 * ТЕМ ЖЕ числом, которым подставляются: модель видит дефолт, не заглядывая в исходники, и
 * не подставляет лимит наугад «на всякий случай».
 */
export function createServer(options: CreateServerOptions): McpServer {
  const { config, logger, deps } = options;
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: { listChanged: true } } },
  );

  server.registerTool(
    'list_chats',
    {
      title: 'List chats',
      description:
        'Список чатов со счётчиком непрочитанного, свежие первыми. Точка входа: единственный ' +
        'инструмент, которому не нужен заранее известный идентификатор. Стоит два вызова к серверу. ' +
        'Текст последних сообщений по умолчанию НЕ отдаётся, только метаданные.',
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe(`Максимум чатов (по умолчанию ${config.limits.listChatsDefaultLimit})`),
        unread_only: z.boolean().optional().describe('Вернуть только чаты с непрочитанными сообщениями'),
        include_last_message_text: z
          .boolean()
          .optional()
          .describe(
            'Вернуть последнее сообщение каждого чата страницы вместе с текстом. По умолчанию false ' +
              'по двум причинам: цена (ОДИН дополнительный вызов НА КАЖДЫЙ чат страницы) и приватность ' +
              '(иначе один вызов тащит в контекст содержимое всех переписок сразу).',
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        return jsonResult(await listChats(deps, args));
      } catch (error) {
        return errorResult('list_chats', error, logger);
      }
    },
  );

  server.registerTool(
    'get_history',
    {
      title: 'Get chat history',
      description:
        'Страница переписки чата: постранично курсором либо окном по датам. Курсор before ' +
        'ИСКЛЮЧАЮЩИЙ: сообщение с этим идентификатором в выдачу не попадает. Фильтры по датам ' +
        'считаются на стороне сервера MCP и могут стоить нескольких вызовов истории.',
      inputSchema: {
        chat: z
          .string()
          .min(1)
          .describe('Идентификатор чата (UUID) либо запрос по имени: «Дежурка», «Избранное»'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe(`Максимум сообщений на страницу (по умолчанию ${config.limits.historyDefaultLimit})`),
        before: z
          .string()
          .regex(UUID_PATTERN)
          .optional()
          .describe(
            'Курсор: message_id (UUID), вернуть сообщения строго старше него. Значение для ' +
              'следующей страницы это next_before из предыдущей выдачи',
          ),
        from_date: z
          .string()
          .optional()
          .describe('ISO-дата либо дата-время нижней ВКЛЮЧАЮЩЕЙ границы. Пример: 2026-09-08'),
        to_date: z
          .string()
          .optional()
          .describe(
            'ISO-дата либо дата-время верхней ИСКЛЮЧАЮЩЕЙ границы: сообщение ровно на to_date не ' +
              'попадает. Для «сообщений за сегодня» передайте from_date=сегодня, to_date=завтра',
          ),
        after: z
          .string()
          .optional()
          .describe('ISO: сообщения строго ПОСЛЕ этого момента, альтернатива from_date'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        return jsonResult(await getHistory(deps, args));
      } catch (error) {
        return errorResult('get_history', error, logger);
      }
    },
  );

  server.registerTool(
    'get_message',
    {
      title: 'Get single message',
      description:
        'Одно сообщение по паре чат и message_id, без загрузки истории вокруг него. Путь адресного ' +
        'чтения подтверждён живой пробой; если сервер на него не ответит, сообщение будет найдено ' +
        'проходом по истории, и выдача от этого не изменится.',
      inputSchema: {
        chat: z.string().min(1).describe('Идентификатор чата (UUID) либо запрос по имени'),
        message_id: z
          .string()
          .regex(UUID_PATTERN)
          .describe('Идентификатор сообщения (UUID) из выдачи get_history'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        return jsonResult(await getMessage(deps, args));
      } catch (error) {
        return errorResult('get_message', error, logger);
      }
    },
  );

  server.registerTool(
    'get_message_context',
    {
      title: 'Get message context',
      description:
        'Окно вокруг сообщения: N сообщений до и N после. Стоит до трёх вызовов истории. ' +
        'Направление обхода вперёд подтверждено живой пробой, поэтому сторона «после» метки ' +
        'неподтверждённости не несёт.',
      inputSchema: {
        chat: z.string().min(1).describe('Идентификатор чата (UUID) либо запрос по имени'),
        message_id: z.string().regex(UUID_PATTERN).describe('Идентификатор сообщения (UUID) в центре окна'),
        before_count: z
          .number()
          .int()
          .min(0)
          .max(200)
          .optional()
          .describe(`Сколько сообщений ДО метки (по умолчанию ${DEFAULT_CONTEXT_WINDOW})`),
        after_count: z
          .number()
          .int()
          .min(0)
          .max(200)
          .optional()
          .describe(`Сколько сообщений ПОСЛЕ метки (по умолчанию ${DEFAULT_CONTEXT_WINDOW})`),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        return jsonResult(await getMessageContext(deps, args));
      } catch (error) {
        return errorResult('get_message_context', error, logger);
      }
    },
  );

  server.registerTool(
    'get_thread',
    {
      title: 'Get thread messages',
      description:
        'Сообщения треда. Тред это чат: у него собственный идентификатор, читается он теми же ' +
        'страницами и той же формой сообщений, а пишут в него обычной отправкой в этот идентификатор. ' +
        'Стоит три вызова к серверу (список чатов, список тредов, страница треда). Список тредов ' +
        'наблюдён живьём, страница треда читается тем же путём, что и история чата, но живьём не ' +
        'подтверждена. Вызов по message_id объявлен неподтверждённым: ' +
        'равенство адреса треда и адреса стартового сообщения снято с бандла веб-клиента, поэтому ' +
        'существование треда дополнительно проверяется по списку.',
      inputSchema: {
        chat: z
          .string()
          .min(1)
          .describe('Родительский чат треда: идентификатор (UUID) либо запрос по имени'),
        thread_id: z
          .string()
          .regex(UUID_PATTERN)
          .optional()
          .describe('Идентификатор треда (UUID), если он уже известен. Точный путь без догадок'),
        message_id: z
          .string()
          .regex(UUID_PATTERN)
          .optional()
          .describe(
            'Идентификатор сообщения (UUID), от которого начат тред: альтернатива thread_id. ' +
              'Передайте что-то одно из двух, иначе вызов вернёт invalid_input',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe(`Максимум сообщений на страницу (по умолчанию ${DEFAULT_THREAD_LIMIT})`),
        before: z
          .string()
          .regex(UUID_PATTERN)
          .optional()
          .describe('Курсор: message_id (UUID), вернуть сообщения строго старше него'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        return jsonResult(await getThread(deps, args));
      } catch (error) {
        return errorResult('get_thread', error, logger);
      }
    },
  );

  server.registerTool(
    'list_reactions',
    {
      title: 'List message reactions',
      description:
        'Реакции одного сообщения полным списком со счётчиками и пометкой своих. Реакция в этом ' +
        'мессенджере это САМ ЭМОДЗИ, а не числовой идентификатор: значение из выдачи годится для ' +
        'показа человеку как есть. Стоит два вызова к серверу. И форма реакций, и оба пути чтения ' +
        'события наблюдены живьём, поэтому меток неподтверждённости выдача не несёт.',
      inputSchema: {
        chat: z.string().min(1).describe('Идентификатор чата (UUID) либо запрос по имени'),
        message_id: z
          .string()
          .regex(UUID_PATTERN)
          .describe('Идентификатор сообщения (UUID) из выдачи get_history'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        return jsonResult(await listReactions(deps, args));
      } catch (error) {
        return errorResult('list_reactions', error, logger);
      }
    },
  );

  server.registerTool(
    'get_poll',
    {
      title: 'Get poll',
      description:
        'Опрос, приложенный к сообщению: вопрос, варианты и настройки СЫРЫМИ полями, без ' +
        'нормализации. Опросы бывают только в групповых чатах, в личном чате и в заметках вызов ' +
        'вернёт not_applicable. Стоит два вызова к серверу. Форма НЕ подтверждена живьём: опрос ' +
        'нельзя завести в чате с собой, поэтому и признак опроса, и состав полей взяты из бандла ' +
        'веб-клиента, о чём говорит form_status в любом исходе. Счётчики голосов приезжают ' +
        'отдельными событиями и в этой выдаче не видны.',
      inputSchema: {
        chat: z.string().min(1).describe('Идентификатор группового чата (UUID) либо запрос по имени'),
        message_id: z
          .string()
          .regex(UUID_PATTERN)
          .describe('Идентификатор сообщения (UUID), к которому приложен опрос'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        return jsonResult(await getPoll(deps, args));
      } catch (error) {
        return errorResult('get_poll', error, logger);
      }
    },
  );

  server.registerTool(
    'download_attachment',
    {
      title: 'Download attachment',
      description:
        'Скачивает вложение сообщения на диск и отдаёт абсолютный путь. ЕДИНСТВЕННЫЙ инструмент ' +
        'набора, который что-то пишет на диск, поэтому и не помечен как read-only. Повтор не ' +
        'идемпотентен: он кладёт рядом ещё одну копию, а не затирает прежнюю. Скачанные файлы ' +
        `удаляются автоматически старше ${config.downloads.ttlDays} дней. Стоит два вызова к серверу ` +
        'плюс саму загрузку. Форма НЕ подтверждена живьём: адрес файловой службы снят с бандла ' +
        'веб-клиента, а потоковый шифр с файла не снимается, поэтому у зашифрованного вложения в ' +
        'ответе стоит encrypted:true и на диске лежит шифротекст.',
      inputSchema: {
        chat: z.string().min(1).describe('Идентификатор чата (UUID) либо запрос по имени'),
        message_id: z
          .string()
          .regex(UUID_PATTERN)
          .describe('Идентификатор сообщения (UUID) с вложением'),
        file_id: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Какое именно вложение скачивать: значение file_id из поля attachments сообщения. ' +
              'Без него берётся первое вложение',
          ),
      },
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    async (args) => {
      try {
        return jsonResult(await downloadAttachment(deps, args));
      } catch (error) {
        return errorResult('download_attachment', error, logger);
      }
    },
  );

  server.registerTool('search', SEARCH_TOOL_DEFINITION, async (args) => {
    try {
      return jsonResult(await search(deps, args));
    } catch (error) {
      return errorResult('search', error, logger);
    }
  });

  server.registerTool(
    'send_message',
    {
      title: 'Send text message',
      description:
        'Отправляет текстовое сообщение в чат. ДВА ШАГА, и первый вызов НИЧЕГО НЕ ОТПРАВЛЯЕТ. ' +
        'Вызов без confirm разрешает чат, показывает превью текста и отдаёт confirm_token со ' +
        'статусом draft. Отправка происходит только на втором вызове, с confirm:true и тем же ' +
        'confirm_token. На втором шаге чат разрешается ЗАНОВО, а текст сверяется с ' +
        'подтверждённым: расхождение чата или текста отклоняет вызов статусом confirm_rejected, ' +
        'а не отправляет «наиболее вероятное». Отправку отменить нельзя, поэтому повтор ' +
        'подтверждения тем же токеном возвращает прежний результат и второго сообщения не создаёт.',
      inputSchema: {
        chat: z
          .string()
          .min(1)
          .describe('Идентификатор чата (UUID) либо запрос по имени: «Дежурка», «Избранное»'),
        text: z
          .string()
          .min(1)
          .max(TEXT_MAX_LENGTH)
          .describe(`Текст сообщения, до ${TEXT_MAX_LENGTH} символов`),
        confirm: z
          .boolean()
          .optional()
          .describe(
            'true отправляет сообщение и требует confirm_token из ответа предыдущего вызова. ' +
              'Без него вызов только готовит отправку и отдаёт превью с токеном',
          ),
        confirm_token: z
          .string()
          .min(1)
          .optional()
          .describe('Токен из ответа со status:"draft". Обязателен при confirm:true'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => {
      try {
        return jsonResult(await sendMessage(deps, args));
      } catch (error) {
        return errorResult('send_message', error, logger);
      }
    },
  );

  return server;
}
