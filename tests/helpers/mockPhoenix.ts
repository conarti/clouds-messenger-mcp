/**
 * Локальный Phoenix-сервер для тестов транспорта.
 *
 * Настоящий сокет, настоящий HTTP-апгрейд, настоящие кадры: подменён только адрес.
 * Мок в памяти здесь не годится принципиально, потому что проверять надо ровно то, что
 * мок в памяти не воспроизводит: query хендшейка, заголовки апгрейда, отказ 401 до
 * апгрейда, обрыв соединения на лету и отсутствие повторной отправки кадра по ВСЕМ
 * соединениям, а не только по последнему.
 */
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { decodeFrame, encodeFrame, REPLY_EVENT, type PhoenixFrame } from '../../src/transport/ws/frames.js';

/** Полезная нагрузка ответа `phx_reply` */
export interface MockReplyPayload {
  status: 'ok' | 'error';
  response?: unknown;
}

/** Ответчик: undefined означает «промолчать», это нужно тестам таймаута и обрыва */
export type FrameResponder = (
  frame: PhoenixFrame,
  connection: MockConnection,
) => MockReplyPayload | undefined;

export interface MockConnection {
  socket: ServerSocket;
  /** Путь с query, как его прислал клиент */
  url: string;
  headers: IncomingHttpHeaders;
  /** Все разобранные входящие кадры этого соединения */
  frames: PhoenixFrame[];
}

/** Разделитель составного ключа ответчика: в именах топиков и событий не встречается */
const KEY_SEPARATOR = ' ';
const ANY_TOPIC = '*';

export class MockPhoenix {
  readonly server: WebSocketServer;
  readonly connections: MockConnection[] = [];

  private readonly responders = new Map<string, FrameResponder>();
  private silentAuthenticateFrames = 0;
  private authenticateErrorCode: string | undefined;
  private authenticateErrorFrames = 0;
  private handshakeRejectStatus = 0;
  private handshakeRejectCount = 0;

  constructor() {
    this.server = new WebSocketServer({
      port: 0,
      host: '127.0.0.1',
      verifyClient: (
        _info: { origin: string; secure: boolean; req: IncomingMessage },
        done: (result: boolean, code?: number, message?: string) => void,
      ) => {
        if (this.handshakeRejectCount > 0) {
          this.handshakeRejectCount -= 1;
          done(false, this.handshakeRejectStatus, 'Unauthorized');
          return;
        }
        done(true);
      },
    });

    this.server.on('connection', (socket, request) => {
      const connection: MockConnection = {
        socket,
        url: request.url ?? '',
        headers: request.headers,
        frames: [],
      };
      this.connections.push(connection);
      socket.on('message', (data: Buffer) => {
        this.onFrame(connection, data.toString('utf8'));
      });
      /* Обрыв соединения это штатный сценарий теста, а не сбой мока */
      socket.on('error', () => undefined);
    });
  }

  get url(): string {
    const { port } = this.server.address() as AddressInfo;
    return `ws://127.0.0.1:${port}/socket/user/websocket`;
  }

  get latest(): MockConnection {
    const connection = this.connections.at(-1);
    if (connection === undefined) {
      throw new Error('mock: соединений не было');
    }
    return connection;
  }

  /**
   * Кадры события по ВСЕМ соединениям. Именно так доказывается «кадр не отправлен повторно»:
   * взгляд только на последнее соединение спрятал бы отправку, случившуюся до реконнекта.
   */
  framesOf(event: string): PhoenixFrame[] {
    return this.connections.flatMap((connection) => connection.frames.filter((frame) => frame.event === event));
  }

  /** Ответчик на событие в любом топике */
  respondTo(event: string, responder: FrameResponder): void {
    this.responders.set(`${ANY_TOPIC}${KEY_SEPARATOR}${event}`, responder);
  }

  /** Ответчик на событие в конкретном топике: он старше общего */
  respondToTopic(topic: string, event: string, responder: FrameResponder): void {
    this.responders.set(`${topic}${KEY_SEPARATOR}${event}`, responder);
  }

  /** Не отвечать на первые `count` кадров authenticate: живое наблюдение молчания сервера */
  silentOnAuthenticate(count: number): void {
    this.silentAuthenticateFrames = count;
  }

  /** Отвечать отказом на первые `count` кадров authenticate */
  rejectAuthenticate(code: string, count = 1): void {
    this.authenticateErrorCode = code;
    this.authenticateErrorFrames = count;
  }

  /** Отвергнуть следующие `count` хендшейков HTTP-статусом до апгрейда */
  rejectHandshake(status: number, count = 1): void {
    this.handshakeRejectStatus = status;
    this.handshakeRejectCount = count;
  }

  /** Оборвать все живые соединения, не закрывая сервер */
  dropAll(): void {
    for (const connection of this.connections) {
      connection.socket.terminate();
    }
  }

  /** Отправляет `phx_reply` на конкретный кадр */
  reply(connection: MockConnection, frame: PhoenixFrame, payload: MockReplyPayload): void {
    connection.socket.send(encodeFrame({ topic: frame.topic, event: REPLY_EVENT, payload, ref: frame.ref }));
  }

  /** Отправляет кадр сервера: событие без ref, как `app_event` в топике `system` */
  sendServerEvent(connection: MockConnection, topic: string, event: string, payload: unknown): void {
    connection.socket.send(encodeFrame({ topic, event, payload, ref: null }));
  }

  async close(): Promise<void> {
    for (const connection of this.connections) {
      connection.socket.terminate();
    }
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private onFrame(connection: MockConnection, raw: string): void {
    const decoded = decodeFrame(raw);
    if (!decoded.ok) {
      return;
    }
    const frame = decoded.frame;
    connection.frames.push(frame);

    if (frame.event === 'authenticate') {
      this.onAuthenticate(connection, frame);
      return;
    }
    if (frame.event === 'heartbeat') {
      this.reply(connection, frame, { status: 'ok', response: {} });
      return;
    }

    const responder =
      this.responders.get(`${frame.topic}${KEY_SEPARATOR}${frame.event}`) ??
      this.responders.get(`${ANY_TOPIC}${KEY_SEPARATOR}${frame.event}`);
    const payload = responder?.(frame, connection);
    if (payload !== undefined) {
      this.reply(connection, frame, payload);
    }
  }

  private onAuthenticate(connection: MockConnection, frame: PhoenixFrame): void {
    if (this.silentAuthenticateFrames > 0) {
      this.silentAuthenticateFrames -= 1;
      return;
    }
    if (this.authenticateErrorCode !== undefined && this.authenticateErrorFrames > 0) {
      this.authenticateErrorFrames -= 1;
      this.reply(connection, frame, { status: 'error', response: { error: this.authenticateErrorCode } });
      return;
    }
    this.reply(connection, frame, { status: 'ok', response: {} });
  }
}

/** Поднимает мок и дожидается listening: иначе `url` отдаст порт ещё не слушающего сервера */
export async function startMockPhoenix(): Promise<MockPhoenix> {
  const mock = new MockPhoenix();
  await new Promise<void>((resolve) => mock.server.once('listening', resolve));
  return mock;
}
