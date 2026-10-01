/**
 * Разбор ссылки на сообщение: мягкий по форме, строгий по значениям.
 */
import { describe, expect, it } from 'vitest';
import { parseMessageLink } from '../../src/chat/messageLink.js';

const CHAT_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const MESSAGE_ID = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';
const QUERY = `sync_id=${MESSAGE_ID}&chat_id=${CHAT_ID}`;

describe('parseMessageLink', () => {
  it.each([
    `https://xlnk.clouds.org.ru/open/message?${QUERY}`,
    `http://xlnk.clouds.org.ru/open/message?${QUERY}`,
    `xlnk.clouds.org.ru/open/message?${QUERY}`,
    `  https://xlnk.clouds.org.ru/open/message/?chat_id=${CHAT_ID}&sync_id=${MESSAGE_ID}  `,
  ])('разбирает вариант %s', (link) => {
    expect(parseMessageLink(link)).toEqual({ chatId: CHAT_ID, messageId: MESSAGE_ID });
  });

  it('имя чата и голый UUID ссылкой не считаются', () => {
    expect(parseMessageLink('Дежурка')).toBeUndefined();
    expect(parseMessageLink(CHAT_ID)).toBeUndefined();
    expect(parseMessageLink('https://xlnk.clouds.org.ru/open/chat?chat_id=x')).toBeUndefined();
  });

  it('значение не в форме UUID считается отсутствующим', () => {
    expect(parseMessageLink(`xlnk.clouds.org.ru/open/message?sync_id=abc&chat_id=${CHAT_ID}`)).toEqual({
      chatId: CHAT_ID,
    });
  });
});
