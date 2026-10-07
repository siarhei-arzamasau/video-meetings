import { randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { text as readToEnd } from 'node:stream/consumers';
import { pipeline } from 'node:stream/promises';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { DEFAULT_TRANSCRIPTION_MODEL } from '../../../../config/transcription.defaults';
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

/** What the endpoint sent back, read to its end. */
interface EndpointAnswer {
  status: number;
  contentType: string | null;
  body: string;
}

/**
 * The one implementation of the port: an OpenAI-compatible `audio/transcriptions` endpoint,
 * which is what the local Whisper server speaks.
 *
 * The object is **streamed**, never buffered: the multipart body is a generator that yields
 * the header, then the file as it is read, then the trailer, so transcribing a gigabyte costs
 * a chunk of memory rather than a gigabyte. It goes out chunked, with no `Content-Length`,
 * because nothing here has measured it.
 *
 * **The request is `node:http`, not `fetch`, and must stay that way.** A Whisper server sends
 * no response header until the whole transcription is done, and `fetch` allows 300 seconds
 * for the first one — a limit set on a dispatcher this process cannot reach without taking
 * undici as a dependency. Every recording that needed longer failed at five minutes, whatever
 * `TRANSCRIPTION_TIMEOUT_SECONDS` said. Here the only bound is the `signal`.
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
    const model = this.config.get<string>('TRANSCRIPTION_MODEL', DEFAULT_TRANSCRIPTION_MODEL);
    const boundary = `----meeting-files-${randomUUID()}`;
    const filename = FILENAMES[contentType] ?? FALLBACK_FILENAME;
    const headers = {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      ...(key === undefined || key === '' ? {} : { authorization: `Bearer ${key}` }),
    };
    let answer: EndpointAnswer;

    try {
      const body = Readable.from(multipart(boundary, filename, contentType, model, stream));

      answer = await post(url, headers, body, signal);
    } catch (error) {
      // An abort lands here too — the step's timeout, or the worker's shutdown — and is not
      // distinguished on purpose: the user's answer is the same either way.
      stream.destroy();
      this.logger.error(
        `Transcription request to model ${model} failed for ${contentType}`,
        error instanceof Error ? error.stack : String(error),
      );

      throw new StepError(TRANSCRIPTION_FAILED_MESSAGE, { cause: error });
    }

    if (answer.status < 200 || answer.status > 299) {
      this.logger.error(
        `Transcription endpoint answered ${String(answer.status)} for model ${model}: ${answer.body.slice(0, 500)}`,
      );

      throw new StepError(TRANSCRIPTION_FAILED_MESSAGE, {
        cause: new Error(`Transcription endpoint answered ${String(answer.status)}`),
      });
    }

    // The model that went on the wire, not the one somebody meant to configure: this line is
    // where an operator reads which model produced a transcript.
    this.logger.log(`Model ${model} transcribed ${contentType}`);

    return textOf(answer.body, answer.contentType);
  }
}

/**
 * One POST with a streamed body, settled when the answer has been read to its end.
 *
 * Three ways it rejects, and they are the same three `fetch` had: the request could not be
 * made or was cut off, the `signal` aborted it, or the answer stopped arriving part-way. The
 * last is why the body is read in here — a timeout that strikes while the transcript is
 * still on its way has to become the same failure as one that strikes before it.
 *
 * Once the endpoint has started answering, an error on the request side is ignored: a server
 * that refuses early and hangs up leaves the rest of the upload with nowhere to go, and the
 * refusal it sent is the thing worth reporting.
 */
function post(
  url: string,
  headers: http.OutgoingHttpHeaders,
  body: Readable,
  signal: AbortSignal,
): Promise<EndpointAnswer> {
  const send = new URL(url).protocol === 'https:' ? https.request : http.request;

  // No shared agent: a connection of its own, closed when the answer ends. Transcriptions
  // are minutes long and minutes apart, and a kept-alive socket the server has closed in the
  // meantime would fail the next recording with a reset. Closing on the answer is also what
  // stops an upload the endpoint refused before it had all of it.
  const options = { method: 'POST', headers, signal, agent: false };

  return new Promise<EndpointAnswer>((resolve, reject) => {
    let answering = false;
    const request = send(url, options, (response) => {
      answering = true;
      readToEnd(response).then(
        (received) =>
          resolve({
            status: response.statusCode ?? 0,
            contentType: response.headers['content-type'] ?? null,
            body: received,
          }),
        reject,
      );
    });
    const failUnlessAnswering = (error: unknown): void => {
      if (!answering) {
        reject(error);
      }
    };

    request.on('error', failUnlessAnswering);
    // Ends the request when the generator does, and carries a read failure of the object
    // into the same rejection as a failure of the connection.
    pipeline(body, request).catch(failUnlessAnswering);
  });
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
