import http from 'node:http';
import type { AddressInfo } from 'node:net';

import type { ApiSuite } from './api-suite';

/** One parsed `text/event-stream` event. `data` is the raw text; the caller parses JSON. */
export interface SseEvent {
  /** The `event:` field, or `message` when the server sent none, as the spec defines. */
  type: string;
  id: string | undefined;
  /** Multi-line `data:` fields joined with newlines; `''` when there were none. */
  data: string;
}

export interface SseClient extends AsyncIterable<SseEvent> {
  status: number;
  headers: http.IncomingHttpHeaders;
  /**
   * The response body, for a stream that was refused: an error is JSON and arrives complete,
   * so a spec asserting on the 404 body has it without reading the stream. Empty for a 200.
   */
  body: string;
  /** The next event, whatever its type. Rejects if the stream ends or nothing comes in time. */
  next(timeoutMs?: number): Promise<SseEvent>;
  /** The next event of this type, skipping (and discarding) any other. */
  nextOf(type: string, timeoutMs?: number): Promise<SseEvent>;
  /** Resolves when the server ends the response — the TTL, or a shutdown. */
  ended(): Promise<void>;
  /** Whether the server has ended the response. */
  isEnded(): boolean;
  /** Hangs up. Safe to call twice, and safe to call after the server ended it. */
  close(): void;
}

/** How long `next()` waits before giving up, so a spec fails with its own message, not a timeout. */
const DEFAULT_WAIT_MS = 5_000;

/**
 * Opens an SSE route with Node's `http` and returns the events as they arrive.
 *
 * **Supertest cannot do this.** It buffers the whole response and resolves when the server
 * ends it, which for a stream is after the TTL — by which time there is nothing left to
 * assert about ordering, and every test costs the TTL. This holds the response open, parses
 * each event as it lands, and hands the spec one at a time.
 *
 * The suite's server is not listening (supertest listens per request), so the first call
 * binds it to an ephemeral port. `app.close()` in the suite's `afterAll` closes it again.
 */
export async function openSse(
  suite: Pick<ApiSuite, 'app'>,
  url: string,
  token: string,
): Promise<SseClient> {
  const server = suite.app().getHttpServer() as http.Server;
  const port = await listeningPort(server);
  const queue = new EventQueue();
  let text = '';

  const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, path: url, method: 'GET', headers: bearer(token) },
      resolve,
    );
    request.on('error', reject);
    request.end();
    queue.hangUp = () => request.destroy();
  });

  if (response.statusCode !== 200) {
    // An error body is small and complete; read it and be done, so the caller can assert on
    // it exactly as it would on a supertest response.
    return refused(response, await readAll(response), queue);
  }

  response.setEncoding('utf8');
  response.on('data', (chunk: string) => {
    text = parseInto(text + chunk, queue);
  });
  response.on('end', () => queue.finish());
  response.on('close', () => queue.finish());
  response.on('error', () => queue.finish());

  return client(response, '', queue);
}

function bearer(token: string): http.OutgoingHttpHeaders {
  return { authorization: `Bearer ${token}`, accept: 'text/event-stream' };
}

async function listeningPort(server: http.Server): Promise<number> {
  if (!server.listening) {
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
  }

  return (server.address() as AddressInfo).port;
}

function readAll(response: http.IncomingMessage): Promise<string> {
  return new Promise<string>((resolve) => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => {
      body += chunk;
    });
    response.on('end', () => resolve(body));
  });
}

function refused(response: http.IncomingMessage, body: string, queue: EventQueue): SseClient {
  queue.finish();

  return client(response, body, queue);
}

function client(response: http.IncomingMessage, body: string, queue: EventQueue): SseClient {
  return {
    status: response.statusCode ?? 0,
    headers: response.headers,
    body,
    next: (timeoutMs = DEFAULT_WAIT_MS) => queue.next(timeoutMs),
    nextOf: (type, timeoutMs = DEFAULT_WAIT_MS) => skipTo(queue, type, Date.now() + timeoutMs),
    // `for await (const event of stream)`, ending when the server ends the response. A wait
    // that times out throws rather than ending, so a stalled stream is a failure with a
    // message and not a loop that quietly stops.
    [Symbol.asyncIterator]: (): AsyncIterator<SseEvent> => ({
      next: async () => {
        const event = await queue.take(DEFAULT_WAIT_MS);

        return event === null ? { value: undefined, done: true } : { value: event, done: false };
      },
    }),
    ended: () => queue.ended(),
    isEnded: () => queue.isEnded(),
    close: () => {
      queue.hangUp();
      queue.finish();
    },
  };
}

/**
 * Reads until an event of `type` arrives, discarding whatever else turns up — a heartbeat,
 * usually. Recursive rather than a loop with an `await` in it, the shape this workspace's
 * lint rule steers towards; the deadline is absolute, so skipping is not a way to wait longer.
 */
async function skipTo(queue: EventQueue, type: string, deadline: number): Promise<SseEvent> {
  const event = await queue.next(Math.max(1, deadline - Date.now()));

  return event.type === type ? event : skipTo(queue, type, deadline);
}

/**
 * Consumes whole events from `buffer` and returns what is left over.
 *
 * Events are separated by a blank line, so anything after the last one is a partial event
 * still arriving and stays in the buffer. Both line endings are handled because the format
 * allows either; Nest writes `\n`.
 */
function parseInto(buffer: string, queue: EventQueue): string {
  const parts = buffer.split(/\r\n\r\n|\n\n|\r\r/);
  const rest = parts.pop() ?? '';

  for (const part of parts) {
    const event = parseEvent(part);

    if (event !== null) {
      queue.push(event);
    }
  }

  return rest;
}

function parseEvent(block: string): SseEvent | null {
  const lines = block.split(/\r\n|\n|\r/).filter((line) => line !== '');
  const data: string[] = [];
  let type = 'message';
  let id: string | undefined;

  for (const line of lines) {
    // A comment. The spec says to ignore it; a heartbeat spelled that way lands here.
    if (line.startsWith(':')) {
      continue;
    }

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');

    if (field === 'event') {
      type = value;
    } else if (field === 'id') {
      id = value;
    } else if (field === 'data') {
      data.push(value);
    }
  }

  return lines.length === 0 ? null : { type, id, data: data.join('\n') };
}

/**
 * Events on one side, waiting `next()` calls on the other, and whichever arrives first waits
 * for the other. A spec that asks for an event before the worker has produced it must not
 * miss it, and one that asks after must not block.
 */
class EventQueue {
  hangUp: () => void = () => {};
  private readonly buffered: SseEvent[] = [];
  private readonly waiting: Array<(event: SseEvent | null) => void> = [];
  private readonly waitingForEnd: Array<() => void> = [];
  private done = false;

  push(event: SseEvent): void {
    const waiter = this.waiting.shift();

    if (waiter === undefined) {
      this.buffered.push(event);

      return;
    }

    waiter(event);
  }

  finish(): void {
    if (this.done) {
      return;
    }

    this.done = true;

    // Whoever is waiting for an event that will never come is told the stream is over,
    // rather than being left to time out.
    for (const deliver of this.waiting.splice(0)) {
      deliver(null);
    }

    for (const resolve of this.waitingForEnd.splice(0)) {
      resolve();
    }
  }

  isEnded(): boolean {
    return this.done;
  }

  ended(): Promise<void> {
    return this.done
      ? Promise.resolve()
      : new Promise<void>((resolve) => this.waitingForEnd.push(resolve));
  }

  async next(timeoutMs: number): Promise<SseEvent> {
    const event = await this.take(timeoutMs);

    if (event === null) {
      throw new Error('The event stream ended before the next event');
    }

    return event;
  }

  /** The next event, or `null` once the server has ended the response and nothing is left. */
  take(timeoutMs: number): Promise<SseEvent | null> {
    const buffered = this.buffered.shift();

    if (buffered !== undefined) {
      return Promise.resolve(buffered);
    }

    if (this.done) {
      return Promise.resolve(null);
    }

    return new Promise<SseEvent | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Drop the waiter, so a later event does not resolve a promise nobody holds.
        const index = this.waiting.indexOf(deliver);

        if (index !== -1) {
          this.waiting.splice(index, 1);
        }

        reject(new Error(`No event within ${String(timeoutMs)}ms`));
      }, timeoutMs);

      const deliver = (event: SseEvent | null): void => {
        clearTimeout(timer);
        resolve(event);
      };

      this.waiting.push(deliver);
    });
  }
}
