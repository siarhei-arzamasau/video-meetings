import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';

import { Logger } from '@nestjs/common';

import { StepError } from '../step';
import {
  HttpTranscriptionProvider,
  TRANSCRIPTION_FAILED_MESSAGE,
} from './http-transcription.provider';
import { audio, config, startServer } from './http-transcription.provider.fixture';

/** 64 KiB each: 64 GiB, which no spec uploads — one that tried would time out. */
const ENDLESS_ENOUGH_CHUNKS = 1_048_576;

/**
 * How the request travels, apart from what it says: the body streamed and unmeasured, a
 * connection of its own, no `fetch`, and what ends it early — a refusal, or the signal.
 */
describe('HttpTranscriptionProvider: the transport', () => {
  let stop: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await stop?.();
    stop = undefined;
  });

  it('sends the body chunked, with no Content-Length, because the object is never measured', async () => {
    // What a streamed body looks like on the wire, and what the endpoint has to accept: the
    // local Whisper server does. An adapter that started declaring a length would have had
    // to read the whole recording first to know it.
    const server = await startServer((_received, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok');
    });
    stop = server.close;
    const provider = new HttpTranscriptionProvider(config({ TRANSCRIPTION_API_URL: server.url }));

    await provider.transcribe(audio(), 'audio/mpeg', AbortSignal.timeout(10_000));

    expect(server.received[0]?.transferEncoding).toBe('chunked');
    expect(server.received[0]?.contentLength).toBeUndefined();
  });

  it('uses a connection of its own for each recording, and says it will not reuse it', async () => {
    // Transcriptions are minutes long and minutes apart. A kept-alive socket the server has
    // closed in the meantime would fail the next recording with a reset it did nothing to earn.
    const server = await startServer((_received, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok');
    });
    stop = server.close;
    const provider = new HttpTranscriptionProvider(config({ TRANSCRIPTION_API_URL: server.url }));

    await provider.transcribe(audio(), 'audio/mpeg', AbortSignal.timeout(10_000));
    await provider.transcribe(audio(), 'audio/mpeg', AbortSignal.timeout(10_000));

    expect(server.received.map((request) => request.connection)).toEqual(['close', 'close']);
  });

  it('does not go through fetch, whose five-minute wait for an answer nothing here can lift', async () => {
    // Node's `fetch` gives a server 300 seconds to send its first response header, and a
    // Whisper server sends none until the transcription is finished — so every recording
    // that took longer failed at five minutes, whatever TRANSCRIPTION_TIMEOUT_SECONDS said.
    // A spec cannot wait that long; what it can pin is that the request is not made that way.
    const fetched = jest.spyOn(globalThis, 'fetch');
    const server = await startServer((_received, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok');
    });
    stop = server.close;
    const provider = new HttpTranscriptionProvider(config({ TRANSCRIPTION_API_URL: server.url }));

    try {
      await expect(
        provider.transcribe(audio(), 'audio/mpeg', AbortSignal.timeout(10_000)),
      ).resolves.toBe('ok');
      expect(fetched).not.toHaveBeenCalled();
    } finally {
      fetched.mockRestore();
    }
  });

  it('reports a refusal sent before the upload finished, and stops uploading', async () => {
    // An endpoint may refuse on the headers alone — a bad key, a body it will not take — and
    // the log has to carry that refusal rather than whatever became of the unfinished upload.
    //
    // A raw socket, because the case worth pinning is the one an HTTP server will not play: it
    // answers at once and then keeps reading, as a proxy in front of the endpoint may. Nothing
    // on the wire ever tells the client to stop, so only the adapter can.
    const failed = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => undefined);
      socket.once('data', () => {
        socket.write(
          'HTTP/1.1 413 Payload Too Large\r\nContent-Type: text/plain\r\n' +
            'Content-Length: 9\r\nConnection: close\r\n\r\ntoo large',
        );
      });
      socket.resume();
    });
    await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
    stop = () =>
      new Promise<void>((done) => {
        sockets.forEach((socket) => socket.destroy());
        server.close(() => done());
      });
    const { port } = server.address() as AddressInfo;
    const provider = new HttpTranscriptionProvider(
      config({ TRANSCRIPTION_API_URL: `http://127.0.0.1:${String(port)}/v1/audio/transcriptions` }),
    );
    let chunksRead = 0;
    const recording = Readable.from(
      (function* (): Generator<Buffer> {
        for (; chunksRead < ENDLESS_ENOUGH_CHUNKS; chunksRead += 1) {
          yield Buffer.alloc(64 * 1024);
        }
      })(),
    );

    try {
      const failure = await provider
        .transcribe(recording, 'video/mp4', AbortSignal.timeout(10_000))
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(StepError);
      expect(failed).toHaveBeenCalledWith(expect.stringContaining('answered 413'));

      // The recording is let go of, not read to its end for a server that has stopped
      // listening. On a kept-alive connection this would wait on 64 GiB and time out.
      if (!recording.closed) {
        await new Promise<void>((closed) => recording.once('close', closed));
      }

      expect(chunksRead).toBeLessThan(ENDLESS_ENOUGH_CHUNKS);
    } finally {
      failed.mockRestore();
    }
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

  it('turns a timeout that strikes while the body is still arriving into the same StepError', async () => {
    const server = await startServer((_received, response) => {
      // Headers and half a transcript, then silence: the request has succeeded as far as
      // `fetch` is concerned, and only the body read can notice the abort.
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.write('Good morning, every');
    });
    stop = server.close;
    const provider = new HttpTranscriptionProvider(config({ TRANSCRIPTION_API_URL: server.url }));

    const failure = await provider
      .transcribe(audio(), 'audio/mpeg', AbortSignal.timeout(150))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(StepError);
    expect((failure as StepError).userMessage).toBe(TRANSCRIPTION_FAILED_MESSAGE);
  });
});
