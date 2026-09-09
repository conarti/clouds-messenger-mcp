/**
 * Отбор для поиска: совпадение по имени чата и вывод контакта из личного чата.
 *
 * Живёт в протоколе, а не в инструменте, ради одного значения: `chat`. Это `chat_type` с
 * провода, и знание о том, какой именно тип означает переписку ровно с одним собеседником,
 * принадлежит нижнему слою (Принцип 1). Инструмент спрашивает «это контакт?», а не сверяет
 * строку типа сам.
 *
 * КОНТАКТ ВЫВОДИТСЯ, А НЕ НАХОДИТСЯ. Глобального серверного поиска людей по строке у
 * платформы нет: справка о профилях спрашивается списком huid и отвечает только про них,
 * а веб-клиент ищет людей локально по уже загруженным профилям. Поэтому выдача людей
 * неполна ПО ПОСТРОЕНИЮ, и неполнота обязана уехать наружу пометкой: человек без личного
 * чата отсюда не виден никак, а пустая выдача выглядела бы как «такого нет».
 *
 * ИМЯ СОБЕСЕДНИКА УЖЕ ЛЕЖИТ В ЗАПИСИ ЧАТА. Подставляет его `resolvePeerNames` до отбора,
 * поэтому здесь достаточно сравнивать `name`: второй ветки «а если это личный чат» тут
 * быть не должно, иначе имя человека сравнивалось бы в двух местах по-разному.
 */
import { PERSONAL_CHAT_TYPE, type ChatRecord } from './chatShape.js';

export { PERSONAL_CHAT_TYPE };

/** Контакт, выведенный из личного чата: адресуется тем же chat_id, что и сам чат */
export interface ContactHit {
  name: string;
  chat_id: string;
  kind: typeof PERSONAL_CHAT_TYPE;
  company_position?: string;
  department?: string;
}

/**
 * Совпадение по имени: подстрока без учёта регистра.
 *
 * Чат без имени не совпадает ни с чем, включая пустой запрос: имени у него нет, и считать
 * отсутствие имени совпадением значит выдать чат за найденный по строке, которой в нём нет.
 */
export function matchesChatName(chat: ChatRecord, loweredQuery: string): boolean {
  return chat.name?.toLowerCase().includes(loweredQuery) === true;
}

/**
 * Совпадение контакта: имя, должность или подразделение.
 *
 * Должность и подразделение ищутся вместе с именем, потому что человека спрашивают и так:
 * «кто у нас бухгалтер». Ровно эти три поля ищет и веб-клиент, и добавлять сюда почту
 * незачем: по ней ищут точным адресом, а не подстрокой.
 */
export function matchesContact(chat: ChatRecord, loweredQuery: string): boolean {
  if (chat.kind !== PERSONAL_CHAT_TYPE) {
    return false;
  }
  const haystack = [chat.name, chat.peer?.company_position, chat.peer?.department];
  return haystack.some((value) => value?.toLowerCase().includes(loweredQuery) === true);
}

/**
 * Личный чат в контакт. Личный чат без имени контактом не становится: имя собеседника
 * здесь единственное, что известно о человеке, и запись без него ничего не сообщает.
 */
export function toContactHit(chat: ChatRecord): ContactHit | undefined {
  if (chat.kind !== PERSONAL_CHAT_TYPE || chat.name === undefined) {
    return undefined;
  }
  return {
    name: chat.name,
    chat_id: chat.chat_id,
    kind: PERSONAL_CHAT_TYPE,
    ...(chat.peer?.company_position !== undefined
      ? { company_position: chat.peer.company_position }
      : {}),
    ...(chat.peer?.department !== undefined ? { department: chat.peer.department } : {}),
  };
}
