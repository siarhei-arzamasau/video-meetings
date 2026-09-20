import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';

import { ConfigService } from '@nestjs/config';

import { StepError } from '../step';
import {
  HttpTranscriptionProvider,
  TRANSCRIPTION_FAILED_MESSAGE,
} from './http-transcription.provider';

interface Received {
  method: string;
  contentType: string;
  authorization: string | undefined;
  body: string;
}

/** A stand-in endpoint on a loopback port: the real client, a real socket, no network. */
function startServer(
  handler: (received: Received, response: http.ServerResponse) => void,
): Promise<{ url: string; received: Received[]; close: () => Promise<void> }> {
  const received: Received[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const entry: Received = {
        method: request.method ?? '',
        contentType: request.headers['content-type'] ?? '',
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString('latin1'),
      };
      received.push(entry);
      handler(entry, response);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${String(port)}/v1/audio/transcriptions`,
        received,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

const config = (values: Record<string, string>): ConfigService =>
  ({
    get: <T>(key: string, fallback?: T): T | string | undefined => values[key] ?? fallback,
  }) as unknown as ConfigService;

const audio = (): Readable => Readable.from([Buffer.from('ID3 fake audio bytes')]);

describe('HttpTranscriptionProvider', () => {
  let stop: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await stop?.();
    stop = undefined;
  });

  it('posts the object as a streamed multipart body and returns the text verbatim', async () => {
    const server = await startServer((_received, response) => {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('  Good morning, everyone.  ');
    });
    stop = server.close;
    const provider = new HttpTranscriptionProvider(
      config({ TRANSCRIPTION_API_URL: server.url, TRANSCRIPTION_MODEL: 'whisper-1' }),
    );

    const text = await provider.transcribe(audio(), 'audio/mpeg', AbortSignal.timeout(10_000));

    // Verbatim: leading and trailing space included. Trimming is a decision for whoever
    // displays it, and this step is not that.
    expect(text).toBe('  Good morning, everyone.  ');

    const [request] = server.received;
    expect(request?.method).toBe('POST');
    expect(request?.contentType).toMatch(/^multipart\/form-data; boundary=----meeting-files-/);
    expect(request?.body).toContain('name="model"\r\n\r\nwhisper-1');
    expect(request?.body).toContain('name="response_format"\r\n\r\ntext');
    // The filename is derived from the sniffed type, never from the user's name.
    expect(request?.body).toContain('name="file"; filename="recording.mp3"');
    expect(request?.body).toContain('Content-Type: audio/mpeg');
    expect(request?.body).toContain('ID3 fake audio bytes');
  });

  it('sends a bearer header when a key is configured, and none when it is not', async () => {
    const server = await startServer((_received, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok');
    });
    stop = server.close;

    await new HttpTranscriptionProvider(
      config({ TRANSCRIPTION_API_URL: server.url, TRANSCRIPTION_API_KEY: 'sk-secret' }),
    ).transcribe(audio(), 'audio/mpeg', AbortSignal.timeout(10_000));
    await new HttpTranscriptionProvider(config({ TRANSCRIPTION_API_URL: server.url })).transcribe(
      audio(),
      'audio/mpeg',
      AbortSignal.timeout(10_000),
    );

    expect(server.received[0]?.authorization).toBe('Bearer sk-secret');
    expect(server.received[1]?.authorization).toBeUndefined();
  });

  it('names the file after the sniffed type, and falls back for an unknown one', async () => {
    const server = await startServer((_received, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok');
    });
    stop = server.close;
    const provider = new HttpTranscriptionProvider(config({ TRANSCRIPTION_API_URL: server.url }));

    await provider.transcribe(audio(), 'video/webm', AbortSignal.timeout(10_000));
    await provider.transcribe(audio(), 'audio/x-unheard-of', AbortSignal.timeout(10_000));

    expect(server.received[0]?.body).toContain('filename="recording.webm"');
    expect(server.received[1]?.body).toContain('filename="recording.mp3"');
  });

  it("unwraps OpenAI's JSON envelope when the endpoint answers with one anyway", async () => {
    const server = await startServer((_received, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ text: 'Good morning, everyone.' }));
    });
    stop = server.close;
    const provider = new HttpTranscriptionProvider(config({ TRANSCRIPTION_API_URL: server.url }));

    await expect(
      provider.transcribe(audio(), 'audio/mpeg', AbortSignal.timeout(10_000)),
    ).resolves.toBe('Good morning, everyone.');
  });

  it('turns a non-2xx into a StepError that says nothing about the endpoint', async () => {
    const server = await startServer((_received, response) => {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Incorrect API key sk-secret' } }));
    });
    stop = server.close;
    const provider = new HttpTranscriptionProvider(config({ TRANSCRIPTION_API_URL: server.url }));

    const failure = await provider
      .transcribe(audio(), 'audio/mpeg', AbortSignal.timeout(10_000))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(StepError);
    expect((failure as StepError).userMessage).toBe(TRANSCRIPTION_FAILED_MESSAGE);
    // The vendor's message, and the key it quoted back, stay in the log.
    expect((failure as StepError).userMessage).not.toContain('sk-secret');
  });

  it('turns a timeout into the same StepError rather than hanging', async () => {
    const server = await startServer(() => {
      // Never answers: the request is only ended by the abort.
    });
    stop = server.close;
    const provider = new HttpTranscriptionProvider(config({ TRANSCRIPTION_API_URL: server.url }));

    const failure = await provider
      .transcribe(audio(), 'audio/mpeg', AbortSignal.timeout(150))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(StepError);
    expect((failure as StepError).userMessage).toBe(TRANSCRIPTION_FAILED_MESSAGE);
  });

  it('fails with the same message when no endpoint is configured', async () => {
    const provider = new HttpTranscriptionProvider(config({}));

    await expect(
      provider.transcribe(audio(), 'audio/mpeg', AbortSignal.timeout(10_000)),
    ).rejects.toThrow(TRANSCRIPTION_FAILED_MESSAGE);
  });
});
