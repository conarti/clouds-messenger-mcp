/**
 * Сборка крипто-слоя: реализация порта {@link CryptoService} на libsodium.
 *
 * Сервис не знает ни про сокет, ни про профиль: ключи получателей он берёт через REST-порт,
 * а приватный материал ему приносит вызывающий. Это оставляет владельца ключей ровно одного.
 */
import type { Logger } from '../util/logger.js';
import type { RestClient } from '../transport/types.js';
import type {
  CryptoService,
  DecryptKeys,
  EncryptMessageInput,
  EncryptedEventRef,
  MessageNewPayload,
} from './types.js';
import { decryptEvent as decryptEventWithSodium } from './decrypt.js';
import { encryptMessage as encryptMessageWithSodium } from './encrypt.js';
import { KdcKeys } from './keys.js';
import { ensureSodiumReady } from './sodium.js';

export interface SodiumCryptoServiceOptions {
  rest: RestClient;
  logger: Logger;
}

export class SodiumCryptoService implements CryptoService {
  readonly keys: KdcKeys;

  private readonly logger: Logger;

  constructor(options: SodiumCryptoServiceOptions) {
    this.keys = new KdcKeys(options.rest);
    this.logger = options.logger.child({ component: 'crypto' });
  }

  async decryptEvent(
    event: EncryptedEventRef,
    keys: DecryptKeys,
  ): Promise<Record<string, unknown>> {
    await ensureSodiumReady();
    const inner = await decryptEventWithSodium(event, keys);
    /* В лог идут только идентификаторы: ни тел ключей, ни открытого текста */
    this.logger.debug('событие расшифровано', {
      groupChatId: event.group_chat_id,
      syncId: event.sync_id,
    });
    return inner;
  }

  async encryptMessage(input: EncryptMessageInput): Promise<MessageNewPayload> {
    await ensureSodiumReady();
    const message = await encryptMessageWithSodium(input);
    this.logger.debug('исходящее событие зашифровано', {
      groupChatId: input.groupChatId,
      syncId: input.syncId,
      recipientCount: input.recipients.length,
    });
    return message;
  }
}
