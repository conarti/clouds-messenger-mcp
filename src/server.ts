import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  browserInstallInProgress,
  browserUnavailable,
  type ChromiumInstallation,
  type InstallWaitResult,
} from './auth/chromiumInstall.js';
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
 * что пишет файл на диск, но переписки он не меняет, а необратимым считается ровно то,
 * что меняет переписку собеседника: согласие человека агент собирает только на такие
 * вызовы, и дешёвое согласие обесценивало бы дорогое.
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

/** Необратимые инструменты: отправленное не отзывается, согласие собирается до вызова */
export const WRITE_TOOLS = ['send_message'] as const;

/**
 * Поле `thread` общее для всех инструментов чтения сообщений: одна формулировка на все, чтобы
 * описания не разъехались.
 */
const THREAD_FIELD_NOTE =
  ' Сообщение, от которого начат тред, несёт поле thread: {thread_id, replies_count?}. ' +
  'thread_id равен message_id сообщения и годится для get_thread; replies_count это число ' +
  'ответов и отсутствует, если сервер его не отдал. У сообщений без треда поля нет.';

/** Поле `reply_to` общее для всех инструментов чтения сообщений, как и `thread` */
const REPLY_FIELD_NOTE =
  ' Ответ на другое сообщение несёт поле reply_to: {message_id, from?, from_name?, text_preview?}; ' +
  'message_id годится для get_message, text_preview это начало цитаты. У прочих сообщений поля нет.';

/** Параметр `chat` инструментов чтения одного сообщения: чат, тред либо ссылка на сообщение */
const MESSAGE_CHAT_DESCRIPTION =
  'Идентификатор чата (UUID), запрос по имени, адрес треда (UUID) либо ссылка xlnk на ' +
  'сообщение как есть (https://xlnk.clouds.org.ru/open/message?sync_id=...&chat_id=...): из ' +
  'ссылки берётся chat_id, а sync_id подставляется в message_id, если тот не передан';

/** `message_id` инструментов чтения одного сообщения: необязателен при ссылке в `chat` */
function messageIdParameter(description: string) {
  return z
    .string()
    .regex(UUID_PATTERN)
    .optional()
    .describe(
      `${description}. Можно не передавать, если в chat ссылка xlnk на сообщение; без обоих ` +
        'вызов вернёт invalid_input',
    );
}

export interface CreateServerOptions {
  config: Config;
  logger: Logger;
  /** Транспорты, авторизация и крипто: без них не работает ни один инструмент */
  deps: ToolDeps;
  /** Фоновая установка Chromium; без неё инструменты не ждут браузер */
  browserInstall?: Pick<ChromiumInstallation, 'waitFor' | 'onProgress' | 'currentProgress' | 'failure'>;
}

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

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
  const { config, logger, deps, browserInstall } = options;
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: { listChanged: true } } },
  );

  /**
   * ОДНО МЕСТО НА ВСЕ ИНСТРУМЕНТЫ: каждому из них на первом вызове нужен вход через браузер.
   * Идущая установка ждётся в пределах бюджета, а не до конца: иначе вызов оборвал бы
   * таймаут клиента, и загрузка выглядела бы сломанной авторизацией. Отказ установки
   * отдаётся отказом авторизации с командой ручной установки, а не сырой ошибкой запуска.
   *
   * Уведомления о прогрессе уходят, только если клиент прислал токен прогресса: без него
   * слать их некуда, и прогресс остаётся в логе stderr.
   */
  const awaitBrowser = async (tool: string, extra: ToolExtra): Promise<CallToolResult | undefined> => {
    if (browserInstall === undefined) {
      return undefined;
    }
    const progressToken = extra._meta?.progressToken;
    const unsubscribe = browserInstall.onProgress((progress) => {
      if (progressToken === undefined) {
        return;
      }
      extra
        .sendNotification({
          method: 'notifications/progress',
          params: {
            progressToken,
            progress: progress.percent,
            total: 100,
            message: `загрузка Chromium: ${progress.percent}% из ${progress.total}`,
          },
        })
        .catch(() => {
          /* Клиент мог уйти: потерянное уведомление о прогрессе не повод ронять вызов */
        });
    });
    let outcome: InstallWaitResult;
    try {
      outcome = await browserInstall.waitFor(config.auth.browserInstallWaitMs);
    } finally {
      unsubscribe();
    }
    if (outcome === 'pending') {
      return jsonResult(browserInstallInProgress(browserInstall.currentProgress));
    }
    const failure = browserInstall.failure;
    if (outcome === 'failed' && failure !== undefined) {
      return errorResult(tool, browserUnavailable(failure), logger);
    }
    return undefined;
  };

  /** Обёртка обработчика: ожидание браузера, затем вызов, ошибка в форму MCP с тегом слоя */
  const withBrowser =
    <Args>(tool: string, call: (args: Args) => Promise<unknown>) =>
    async (args: Args, extra: ToolExtra): Promise<CallToolResult> => {
      const waiting = await awaitBrowser(tool, extra);
      if (waiting !== undefined) {
        return waiting;
      }
      try {
        return jsonResult(await call(args));
      } catch (error) {
        return errorResult(tool, error, logger);
      }
    };

  server.registerTool(
    'list_chats',
    {
      title: 'List chats',
      description:
        'Список чатов со счётчиком непрочитанного, свежие первыми. Точка входа: единственный ' +
        'инструмент, которому не нужен заранее известный идентификатор. Личные чаты называются ' +
        'именами собеседников и несут peer_huid: сервер отдаёт им одинаковую заглушку имени, ' +
        'а имена приезжают справкой о профилях. Стоит два вызова к серверу плюс справку об ' +
        'именах, если в списке есть личные чаты и они ещё не в кэше. Текст последних сообщений ' +
        'по умолчанию НЕ отдаётся, только метаданные.',
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
    withBrowser('list_chats', (args) => listChats(deps, args)),
  );

  server.registerTool(
    'get_history',
    {
      title: 'Get chat history',
      description:
        'Страница переписки чата: постранично курсором либо окном по датам. В поле chat годится ' +
        'и имя человека: личный чат резолвится по имени собеседника. Курсор before ' +
        'ИСКЛЮЧАЮЩИЙ: сообщение с этим идентификатором в выдачу не попадает. Фильтры по датам ' +
        'считаются на стороне сервера MCP и могут стоить нескольких вызовов истории.' +
        THREAD_FIELD_NOTE +
        REPLY_FIELD_NOTE,
      inputSchema: {
        chat: z
          .string()
          .min(1)
          .describe(
            'Идентификатор чата (UUID), адрес треда (UUID), ссылка xlnk на сообщение либо запрос ' +
              'по имени: «Дежурка», «Избранное»',
          ),
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
    withBrowser('get_history', (args) => getHistory(deps, args)),
  );

  server.registerTool(
    'get_message',
    {
      title: 'Get single message',
      description:
        'Одно сообщение по паре чат и message_id, без загрузки истории вокруг него. Путь адресного ' +
        'чтения подтверждён живой пробой; если сервер на него не ответит, сообщение будет найдено ' +
        'проходом по истории, и выдача от этого не изменится.' +
        THREAD_FIELD_NOTE +
        REPLY_FIELD_NOTE,
      inputSchema: {
        chat: z.string().min(1).describe(MESSAGE_CHAT_DESCRIPTION),
        message_id: messageIdParameter('Идентификатор сообщения (UUID) из выдачи get_history'),
      },
      annotations: { readOnlyHint: true },
    },
    withBrowser('get_message', (args) => getMessage(deps, args)),
  );

  server.registerTool(
    'get_message_context',
    {
      title: 'Get message context',
      description:
        'Окно вокруг сообщения: N сообщений до и N после. Стоит до трёх вызовов истории. ' +
        'Направление обхода вперёд подтверждено живой пробой, поэтому сторона «после» метки ' +
        'неподтверждённости не несёт.' +
        THREAD_FIELD_NOTE +
        REPLY_FIELD_NOTE,
      inputSchema: {
        chat: z.string().min(1).describe(MESSAGE_CHAT_DESCRIPTION),
        message_id: messageIdParameter('Идентификатор сообщения (UUID) в центре окна'),
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
    withBrowser('get_message_context', (args) => getMessageContext(deps, args)),
  );

  server.registerTool(
    'get_thread',
    {
      title: 'Get thread messages',
      description:
        'Сообщения треда. Тред это чат: у него собственный идентификатор, читается он теми же ' +
        'страницами и той же формой сообщений, а пишут в него обычной отправкой в этот идентификатор. ' +
        'Адрес треда равен message_id стартового сообщения; его можно передать прямо в chat. Читается и тред, где пользователь не ' +
        'участник: список тредов содержит только подписки, поэтому промах по нему переспрашивается ' +
        'справкой о треде; source:"direct" означает, что тред найден справкой, а не в списке, ' +
        'participant говорит, участник ли пользователь. Чтение участие не меняет. Стоит три-четыре ' +
        'вызова к серверу (список чатов, список тредов, при промахе справка о треде, страница треда).' +
        THREAD_FIELD_NOTE +
        REPLY_FIELD_NOTE,
      inputSchema: {
        chat: z
          .string()
          .min(1)
          .describe(
            'Родительский чат треда (идентификатор UUID либо запрос по имени) либо адрес самого ' +
              'треда: тогда thread_id и message_id не нужны',
          ),
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
    withBrowser('get_thread', (args) => getThread(deps, args)),
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
    withBrowser('list_reactions', (args) => listReactions(deps, args)),
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
    withBrowser('get_poll', (args) => getPoll(deps, args)),
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
        chat: z.string().min(1).describe(MESSAGE_CHAT_DESCRIPTION),
        message_id: messageIdParameter('Идентификатор сообщения (UUID) с вложением'),
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
    withBrowser('download_attachment', (args) => downloadAttachment(deps, args)),
  );

  server.registerTool(
    'search',
    SEARCH_TOOL_DEFINITION,
    withBrowser('search', (args) => search(deps, args)),
  );

  server.registerTool(
    'send_message',
    {
      title: 'Send text message',
      description:
        'Отправляет текстовое сообщение в чат ОДНИМ вызовом. Отправка необратима: перед ' +
        'вызовом получите явное согласие пользователя на адресата и текст. Повтор вызова ' +
        'создаёт ВТОРОЕ сообщение: если ответ потерян, сначала проверьте get_history. Неоднозначный или незнакомый чат ничего не отправляет и ' +
        'отвечает статусом ambiguous_chat с кандидатами или chat_not_found. Успех отвечает ' +
        'status:"sent" с chat_id, chat_name, message_id и inserted_at, у ответа ещё и reply_to, ' +
        'при упоминаниях ещё и mentions [{huid, name}], при отправке в тред ещё и parent_chat_id. ' +
        'В тред пишут тремя способами: адрес треда в chat, либо родительский чат в chat плюс ' +
        'thread_id, либо плюс message_id стартового сообщения. Тред не найден: статус ' +
        'thread_not_found, ничего не отправлено. Участником треда отправка пользователя не делает.',
      inputSchema: {
        chat: z
          .string()
          .min(1)
          .describe(
            'Идентификатор чата (UUID), адрес треда (UUID), ссылка xlnk на сообщение (берётся её ' +
              'chat_id) либо запрос по имени: «Дежурка», «Избранное»',
          ),
        text: z
          .string()
          .min(1)
          .max(TEXT_MAX_LENGTH)
          .describe(`Текст сообщения, до ${TEXT_MAX_LENGTH} символов`),
        reply_to: z
          .string()
          .regex(UUID_PATTERN)
          .optional()
          .describe(
            'Ответить на сообщение: его message_id (UUID) из выдачи get_history этого же чата ' +
              '(при отправке в тред из выдачи get_thread этого треда). ' +
              'Цитата собирается из самого сообщения. Ненайденное сообщение ничего не отправляет ' +
              'и отвечает статусом reply_target_not_found',
          ),
        mentions: z
          .array(z.string().min(1))
          .optional()
          .describe(
            'Кого упомянуть: huid участника этого чата либо его однозначное имя (полное имя или ' +
              'набор целых слов имени, без учёта регистра). В text для каждого ищется по порядку: ' +
              'маркер @{mention:<эта строка>}, @Полное Имя из справки, @<эта строка>; совпадение ' +
              'только целым словом, одно вхождение на один элемент mentions (чтобы упомянуть ' +
              'человека дважды, передайте его дважды). Ненайденный человек (mention_not_found), ' +
              'неоднозначное имя (ambiguous_mention, с кандидатами) или отсутствие места в ' +
              'тексте (mention_not_in_text) отменяют отправку целиком',
          ),
        thread_id: z
          .string()
          .regex(UUID_PATTERN)
          .optional()
          .describe(
            'Отправить в тред этого чата: идентификатор треда (UUID). Не нужен, если в chat уже ' +
              'адрес треда',
          ),
        message_id: z
          .string()
          .regex(UUID_PATTERN)
          .optional()
          .describe(
            'СТАРТОВОЕ сообщение треда (UUID), то есть сообщение родительского чата, от которого ' +
              'начат тред: отправка уходит в этот тред. Альтернатива thread_id (адрес треда равен ' +
              'message_id стартового сообщения). Это НЕ ответ на сообщение: для ответа есть reply_to',
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    withBrowser('send_message', (args) => sendMessage(deps, args)),
  );

  return server;
}
