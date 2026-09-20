import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { StepError } from '../step';
import { TranscriptionProvider } from './transcription-provider';

export const TRANSCRIPTION_FAILED_MESSAGE = 'The recording could not be transcribed';

/**
 * The filename each stored type is sent under. An OpenAI-compatible endpoint routes on the
 * extension of the multipart filename, not on the part's `Content-Type`, so a name it does
 * not recognise is rejected before a single sample is decoded. The record's own name never
 * goes on the wire: it is the user's text, and this is a third party.
 */
const FILENAMES: Record<string, string> = {
  'audio/mpeg': 'recording.mp3',
  'audio/mp4': 'recording.m4a',
  'audio/wav': 'recording.wav',
  'video/mp4': 'recording.mp4',
  'video/webm': 'recording.webm',
};

const FALLBACK_FILENAME = 'recording.mp3';

/**
 * The one implementation of the port: an OpenAI-compatible `audio/transcriptions` endpoint,
 * which is served by hosted providers and by self-hosted Whisper servers alike.
 *
 * The object is **streamed**, never buffered: the multipart body is a generator that yields
 * the header, then the file as it is read, then the trailer, so transcribing a gigabyte costs
 * a chunk of memory rather than a gigabyte. That is also why this is `fetch` with
 * `duplex: 'half'` and not a `FormData` with a `Blob`, which would read the whole object
 * first.
 *
 * Every failure — a non-2xx, a timeout, a dropped connection — is one `StepError` with one
 * message. The real cause is logged with its stack; what reaches `failureReason`, and so the
 * user, says the recording could not be transcribed and nothing about the endpoint.
 */
@Injectable()
export class HttpTranscriptionProvider implements TranscriptionProvider {
  private readonly logger = new Logger(HttpTranscriptionProvider.name);

  constructor(private readonly config: ConfigService) {}

  async transcribe(stream: Readable, contentType: string, signal: AbortSignal): Promise<string> {
    const url = this.config.get<string>('TRANSCRIPTION_API_URL', '');

    if (url === '') {
      throw new StepError(TRANSCRIPTION_FAILED_MESSAGE, {
        cause: new Error('TRANSCRIPTION_API_URL is not set'),
      });
    }

    const key = this.config.get<string>('TRANSCRIPTION_API_KEY');
    const model = this.config.get<string>('TRANSCRIPTION_MODEL', 'whisper-1');
    const boundary = `----meeting-files-${randomUUID()}`;
    const filename = FILENAMES[contentType] ?? FALLBACK_FILENAME;

    let response: Response;

    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          ...(key === undefined || key === '' ? {} : { authorization: `Bearer ${key}` }),
        },
        body: Readable.toWeb(
          Readable.from(multipart(boundary, filename, contentType, model, stream)),
        ) as ReadableStream<Uint8Array>,
        // Required for a streaming request body: the request is still being written while the
        // response is being read. Not in the DOM `RequestInit` type, hence the assertion.
        duplex: 'half',
        signal,
      } as RequestInit);
    } catch (error) {
      // An abort lands here too — the step's timeout, or a shutdown — and is not distinguished
      // on purpose: the user's answer is the same either way.
      stream.destroy();
      this.logger.error(
        `Transcription request failed for ${contentType}`,
        error instanceof Error ? error.stack : String(error),
      );

      throw new StepError(TRANSCRIPTION_FAILED_MESSAGE, { cause: error });
    }

    const body = await response.text();

    if (!response.ok) {
      this.logger.error(
        `Transcription endpoint answered ${String(response.status)}: ${body.slice(0, 500)}`,
      );

      throw new StepError(TRANSCRIPTION_FAILED_MESSAGE, {
        cause: new Error(`Transcription endpoint answered ${String(response.status)}`),
      });
    }

    return textOf(body, response.headers.get('content-type'));
  }
}

/**
 * The body, in three pieces: the fields and the file part's header, the object itself as it
 * arrives, and the closing boundary.
 */
async function* multipart(
  boundary: string,
  filename: string,
  contentType: string,
  model: string,
  stream: Readable,
): AsyncGenerator<Buffer> {
  yield Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n` +
      // Plain text back, rather than the JSON envelope: there is nothing else in the answer
      // this step wants, and a server that ignores the field is handled on the way out.
      `--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\ntext\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
  );

  for await (const chunk of stream) {
    yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
  }

  yield Buffer.from(`\r\n--${boundary}--\r\n`);
}

/**
 * The transcript as the endpoint returned it. `response_format=text` asks for plain text, but
 * a server that answers with OpenAI's JSON envelope anyway is common enough to unwrap rather
 * than store `{"text":"…"}` as though it were the transcript.
 */
function textOf(body: string, contentType: string | null): string {
  if (contentType === null || !contentType.includes('json')) {
    return body;
  }

  try {
    const parsed: unknown = JSON.parse(body);

    if (typeof parsed === 'object' && parsed !== null && 'text' in parsed) {
      const { text } = parsed as { text: unknown };

      if (typeof text === 'string') {
        return text;
      }
    }
  } catch {
    // Not JSON after all; the body is the transcript.
  }

  return body;
}
