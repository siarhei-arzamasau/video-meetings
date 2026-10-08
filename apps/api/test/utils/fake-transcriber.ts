import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** One request the fake received, with the recording's part of the multipart body measured. */
export interface TranscriberCall {
  /** The `model` field. */
  model: string;
  /** The file part's filename — the adapter's, never the user's. */
  filename: string;
  /** Bytes of the file part: the whole stored object, if the adapter streamed all of it. */
  bytes: number;
}

/** What the fake does with a request once it has read it. */
export type TranscriberReply =
  | { kind: 'text'; text: string }
  | { kind: 'error'; status: number; body: string }
  /** No answer until `release()` — or until the caller hangs up, which is counted. */
  | { kind: 'hold' };

const PATH = '/v1/audio/transcriptions';

/**
 * A stand-in for the Whisper service: an OpenAI-shaped `audio/transcriptions` endpoint on
 * loopback that a spec tells to answer, to fail, or to hold.
 *
 * A server rather than a fake bound to the provider token, so the application's own HTTP
 * adapter is what the specs run: an error body the endpoint sends really crosses the wire, and
 * a request the worker aborts really is hung up on. Nothing here transcribes — the reply is
 * whatever `reply` says for the call it is shown.
 */
export class FakeTranscriber {
  /** Every request read to its end, in arrival order. */
  calls: TranscriberCall[] = [];
  /** Requests the caller hung up on before any answer was sent. */
  hangUps = 0;
  /** Decides each reply. Reset to a fixed transcript by `reset()`. */
  reply: (call: TranscriberCall) => TranscriberReply = () => ({ kind: 'text', text: '' });

  private readonly server = http.createServer((request, response) => {
    void this.handle(request, response);
  });
  private readonly held = new Set<http.ServerResponse>();
  private waiters: Array<() => void> = [];

  get url(): string {
    return `http://127.0.0.1:${String((this.server.address() as AddressInfo).port)}${PATH}`;
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', resolve);
    });
  }

  stop(): Promise<void> {
    this.release('');
    this.server.closeAllConnections();

    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  /** Forgets every call and answers `text` to whatever comes next. */
  reset(text: string): void {
    this.release('');
    this.calls = [];
    this.hangUps = 0;
    this.reply = () => ({ kind: 'text', text });
  }

  /** Answers every held request with `text`, as a transcription that has just finished. */
  release(text: string): void {
    for (const response of this.held) {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(text);
    }

    this.held.clear();
  }

  /** Resolves once `count` requests have been read to their end — "the work is in flight". */
  arrived(count: number, timeoutMs = 5_000): Promise<void> {
    if (this.calls.length >= count) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const forget = (): void => {
        this.waiters = this.waiters.filter((waiter) => waiter !== check);
      };
      const timer = setTimeout(() => {
        forget();
        reject(
          new Error(
            `Expected ${String(count)} transcription requests, saw ${String(this.calls.length)}`,
          ),
        );
      }, timeoutMs);
      const check = (): void => {
        if (this.calls.length >= count) {
          clearTimeout(timer);
          forget();
          resolve();
        }
      };

      this.waiters.push(check);
    });
  }

  private async handle(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const body = await readBody(request);

    if (body === null) {
      // The caller hung up part-way through the upload: there is no call to record.
      response.destroy();

      return;
    }

    if (request.method !== 'POST' || request.url !== PATH) {
      response.writeHead(404).end();

      return;
    }

    const call = parseCall(body, request.headers['content-type'] ?? '');
    const reply = this.reply(call);

    this.calls.push(call);
    // A waiter that is satisfied replaces the array rather than editing it, so this is safe.
    for (const check of this.waiters) {
      check();
    }

    this.send(response, reply);
  }

  /** Answers, fails, or holds the request, as `reply` says. A held one counts its hang-up. */
  private send(response: http.ServerResponse, reply: TranscriberReply): void {
    if (reply.kind === 'hold') {
      this.held.add(response);
      response.on('close', () => {
        if (this.held.delete(response)) {
          this.hangUps += 1;
        }
      });

      return;
    }

    if (reply.kind === 'error') {
      response.writeHead(reply.status, { 'content-type': 'application/json' }).end(reply.body);

      return;
    }

    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(reply.text);
  }
}

/** The whole request body, or `null` when the caller hung up before it had sent all of it. */
async function readBody(request: http.IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];

  try {
    for await (const chunk of request) {
      chunks.push(chunk as Buffer);
    }
  } catch {
    return null;
  }

  return Buffer.concat(chunks);
}

/**
 * Reads the two things a spec asserts on out of the multipart body: the `model` field and the
 * file part. The body is latin1-decoded to search it, which maps every byte to one character,
 * so offsets in the string are offsets in the buffer.
 */
function parseCall(body: Buffer, contentType: string): TranscriberCall {
  const boundary = /boundary=(.+)$/.exec(contentType)?.[1] ?? '';
  const text = body.toString('latin1');
  const model = /name="model"\r\n\r\n([^\r]*)\r\n/.exec(text)?.[1] ?? '';
  const filePart = /name="file"; filename="([^"]*)"\r\n[^\r]*\r\n\r\n/.exec(text);

  if (filePart === null) {
    return { model, filename: '', bytes: 0 };
  }

  const start = filePart.index + filePart[0].length;
  const end = text.lastIndexOf(`\r\n--${boundary}--`);

  return { model, filename: filePart[1] ?? '', bytes: Math.max(0, end - start) };
}
