/**
 * Зависимости инструментов.
 *
 * Собираются один раз на старте и БЕЗ ввода-вывода: ни один конструктор здесь не лезет
 * в сеть и не поднимает браузер. Это важно для MCP-контракта: `tools/list` обязан
 * отвечать, не требуя живой сессии; авторизация случается лениво, на первом вызове,
 * который реально ходит к серверу.
 *
 * Карты реакций тут нет намеренно: в Клаудс реакция это сам эмодзи, а не числовой
 * идентификатор артворка, поэтому переводить нечего.
 */
import type { AuthProvider } from '../../auth/AuthProvider.js';
import type { KeyStore } from '../../auth/keyStore.js';
import type { Config } from '../../config/types.js';
import type { CryptoService } from '../../crypto/types.js';
import type { RestClient } from '../../transport/types.js';
import type { PhoenixClient } from '../../transport/ws/types.js';
import type { Logger } from '../../util/logger.js';

export interface ToolDeps {
  ws: PhoenixClient;
  rest: RestClient;
  auth: AuthProvider;
  crypto: CryptoService;
  keyStore: KeyStore;
  config: Config;
  logger: Logger;
}
