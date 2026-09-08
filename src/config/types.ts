/**
 * Протокольные константы Клаудс (findings.md, секция протокольных констант).
 *
 * Живут в конфиге, а не в коде слоёв, потому что хосты и версии протокола дрейфуют
 * вместе с релизами веб-клиента, а перевыпускать пакет ради смены номера версии
 * запроса дороже, чем позволить переопределить значение файлом.
 */
export interface ProtocolConfig {
  /** Origin веб-клиента: там живёт профиль и туда заходит Playwright при входе */
  webOrigin: string;
  /** База REST без завершающего слеша: к ней клеятся пути вида kdcKeysPath */
  restBaseUrl: string;
  /** Phoenix-сокет без query: query собирает PhoenixClient из wsVsn, wsVersion и параметров сессии */
  wsUrl: string;
  /** Значение query `vsn` в хендшейке Phoenix */
  wsVsn: string;
  /** Значение query `version` сокета */
  wsVersion: number;
  /** `request_version` события получения списка чатов */
  chatListRequestVersion: number;
  /** `request_version` события списка тредов */
  threadListRequestVersion: number;
  /** Путь KDC относительно restBaseUrl; полный URL собирает RestClient (Принцип 1) */
  kdcKeysPath: string;
  /**
   * Путь файловой службы относительно restBaseUrl, к нему клеятся идентификатор чата и
   * идентификатор файла. Форма снята с бандла веб-клиента и живой пробой не подтверждена.
   */
  fileServicePath: string;
  /** Заголовок User-Agent: без узнаваемого браузерного значения сервер отвечает отказом */
  userAgent: string;
}

/** Абсолютные пути артефактов, все внутри ~/.config/clouds-messenger-mcp */
export interface PathsConfig {
  /** Файл пользовательского конфига, фактически прочитанный при загрузке */
  configFile: string;
  /** Persistent-профиль браузера: там лежит сессия и ключевой материал */
  profileDir: string;
  /** Каталог скачанных вложений */
  downloadsDir: string;
}

export interface DownloadsConfig {
  /** TTL авто-очистки скачанных файлов в днях */
  ttlDays: number;
  /**
   * Потолок размера одного скачиваемого файла в байтах. Он нужен не ради диска, а ради
   * предсказуемости: размер приезжает из чужого сообщения, и доверять ему нельзя.
   */
  maxFileSizeBytes: number;
}

export interface LimitsConfig {
  listChatsDefaultLimit: number;
  searchDefaultLimit: number;
  historyDefaultLimit: number;
}

export interface AuthConfig {
  /** Бюджет headless-входа: не уложились - поднимается headed-окно */
  headlessTimeoutMs: number;
  /** Бюджет headed-входа: столько времени даётся человеку на ручной вход */
  headedTimeoutMs: number;
}

export interface WsConfig {
  authenticateTimeoutMs: number;
  /**
   * Попытки authenticate. Значение больше единицы не запас на будущее: первый кадр
   * authenticate живьём иногда остаётся без ответа, и повтор это единственное лечение.
   */
  authenticateAttempts: number;
  requestTimeoutMs: number;
  reconnectAttempts: number;
  reconnectBaseDelayMs: number;
  reconnectMaxDelayMs: number;
  heartbeatIntervalMs: number;
}

export interface Config {
  protocol: ProtocolConfig;
  paths: PathsConfig;
  downloads: DownloadsConfig;
  limits: LimitsConfig;
  auth: AuthConfig;
  ws: WsConfig;
}

/**
 * Форма и файла конфига, и программного аргумента: секции и поля опциональны,
 * слияние идёт поточечно внутри секции.
 */
export interface ConfigOverrides {
  protocol?: Partial<ProtocolConfig>;
  paths?: Partial<PathsConfig>;
  downloads?: Partial<DownloadsConfig>;
  limits?: Partial<LimitsConfig>;
  auth?: Partial<AuthConfig>;
  ws?: Partial<WsConfig>;
}
