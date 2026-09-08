/**
 * Формы крипто-слоя. Строки полей провода здесь допустимы и не нарушают Принцип 1:
 * это ровно те записи, которые едут внутри кадра и разбираются криптографией.
 */

/** Ссылка на зашифрованное событие: минимум, которого хватает на расшифровку */
export interface EncryptedEventRef {
  group_chat_id: string;
  sync_id: string;
  /** Ключ отправителя: его публичную половину надо получить, чтобы открыть обёртку */
  sender_key_id: string;
  /** Обёртка контент-ключа на МОЙ ключ-получатель */
  key: {
    key_id: string;
    key: string;
    algo: string;
  };
  /** base64 тела события */
  payload: string;
}

/** Пара ключей для открытия обёртки контент-ключа */
export interface DecryptKeys {
  recipientPrivateKey: Uint8Array;
  senderPublicKey: Uint8Array;
}

/** Публичный ключ получателя: на него оборачивается контент-ключ исходящего сообщения */
export interface RecipientPublicKey {
  keyId: string;
  body: Uint8Array;
}

/** Готовый payload кадра message_new */
export interface MessageNewPayload {
  /** Обёртка контент-ключа на КАЖДОГО получателя чата */
  keys: Array<{
    key_id: string;
    key: string;
    algo: string;
  }>;
  group_chat_id: string;
  sync_id: string;
  payload: string;
  signature: {
    sign: string;
    sign_key_id: string;
    sign_algo: string;
  };
}

export interface CryptoKeys {
  /** Публичная половина ключа отправителя по `sender_key_id` события */
  senderPublicKey(keyId: string): Promise<Uint8Array>;
  /**
   * Публичные тела получателей по списку идентификаторов из `chat.keys`.
   *
   * Получатели берутся из чата, а не из локального профиля: вывод из профиля даёт
   * отказ `invalid_keys`, это проверено живой пробой.
   */
  resolveRecipientPublicKeys(keyIds: readonly string[]): Promise<RecipientPublicKey[]>;
}

export interface CryptoService {
  keys: CryptoKeys;
  /** Открывает событие и отдаёт внутреннее событие как разобранный объект */
  decryptEvent(event: EncryptedEventRef, keys: DecryptKeys): Promise<Record<string, unknown>>;
  /** Шифрует внутреннее событие на всех получателей и подписывает результат */
  encryptMessage(input: {
    innerEvent: Record<string, unknown>;
    groupChatId: string;
    syncId: string;
    recipients: readonly RecipientPublicKey[];
    senderPrivateKey: Uint8Array;
    signPrivateKey: Uint8Array;
    signKeyId: string;
  }): Promise<MessageNewPayload>;
}

/**
 * Вход шифрования исходящего события: именованная форма того же набора, что объявлен
 * в {@link CryptoService.encryptMessage}.
 *
 * Свободная функция шифрования и метод сервиса обязаны принимать одно и то же, иначе они
 * разъедутся при первом изменении состава полей, и разъезд вылезет не на типах, а на проводе.
 */
export interface EncryptMessageInput {
  innerEvent: Record<string, unknown>;
  groupChatId: string;
  syncId: string;
  recipients: readonly RecipientPublicKey[];
  senderPrivateKey: Uint8Array;
  signPrivateKey: Uint8Array;
  signKeyId: string;
}
