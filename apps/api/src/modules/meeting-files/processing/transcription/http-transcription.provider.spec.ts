import { Logger } from '@nestjs/common';

import { StepError } from '../step';
import {
  HttpTranscriptionProvider,
  TRANSCRIPTION_FAILED_MESSAGE,
} from './http-transcription.provider';
import { audio, config, startServer } from './http-transcription.provider.fixture';

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

  it('asks for Whisper small when no model is configured', async () => {
    const server = await startServer((_received, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok');
    });
    stop = server.close;
    const provider = new HttpTranscriptionProvider(config({ TRANSCRIPTION_API_URL: server.url }));

    await provider.transcribe(audio(), 'audio/mpeg', AbortSignal.timeout(10_000));

    expect(server.received[0]?.body).toContain(
      'name="model"\r\n\r\nSystran/faster-whisper-small\r\n',
    );
  });

  it('logs the model it asked for, on an answer and on a refusal alike', async () => {
    // The API log is where an operator reads which model transcribed a recording, so the
    // line has to name the one that went on the wire rather than leave it to be inferred.
    const logged = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const failed = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    let status = 200;
    const server = await startServer((_received, response) => {
      response.writeHead(status, { 'content-type': 'text/plain' });
      response.end('ok');
    });
    stop = server.close;
    const provider = new HttpTranscriptionProvider(
      config({ TRANSCRIPTION_API_URL: server.url, TRANSCRIPTION_MODEL: 'some/other-model' }),
    );

    try {
      await provider.transcribe(audio(), 'audio/mpeg', AbortSignal.timeout(10_000));
      status = 404;
      await provider
        .transcribe(audio(), 'audio/mpeg', AbortSignal.timeout(10_000))
        .catch(() => undefined);

      expect(logged).toHaveBeenCalledWith(expect.stringContaining('some/other-model'));
      expect(failed).toHaveBeenCalledWith(expect.stringContaining('some/other-model'));
    } finally {
      logged.mockRestore();
      failed.mockRestore();
    }
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

  it('fails with the same message when no endpoint is configured', async () => {
    const provider = new HttpTranscriptionProvider(config({}));

    await expect(
      provider.transcribe(audio(), 'audio/mpeg', AbortSignal.timeout(10_000)),
    ).rejects.toThrow(TRANSCRIPTION_FAILED_MESSAGE);
  });
});
