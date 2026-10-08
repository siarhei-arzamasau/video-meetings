import fs from 'node:fs';
import path from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MeetingFile } from '@repo/shared';

import type { ApiSuite } from './api-suite';
import { FakeTranscriber } from './fake-transcriber';
import type { TranscriberReply } from './fake-transcriber';
import {
  MEETING_FILE_TRANSCRIPTION_WORKER_TOKEN,
  MEETING_FILE_WORKER_TOKEN,
  meetingFilesDir,
  meetingFilesUrl,
} from './fixtures';

const FIXTURES = path.join(__dirname, '..', 'fixtures');

export const fixture = (name: string): string => path.join(FIXTURES, name);
export const fixtureSize = (name: string): number => fs.statSync(fixture(name)).size;

/** Where an object, or something stored beside it, lives under the run's storage root. */
export const objectPath = (meetingId: string, fileId: string, suffix = ''): string =>
  path.join(meetingFilesDir(), meetingId, `${fileId}${suffix}`);

export const transcriptPath = (meetingId: string, fileId: string): string =>
  objectPath(meetingId, fileId, '.transcript.txt');

export const TRANSCRIPT = 'Good morning, everyone. Shall we start with the engine?';

/**
 * The failure copy from `@repo/shared`, restated for the reason `fixtures.ts` restates every
 * other sentence: rewording one must fail a spec rather than quietly pass it.
 */
export const TRANSCRIPTION_FAILED_MESSAGE = 'The recording could not be transcribed.';
export const TRANSCRIPTION_REPEATED_FAILURE_MESSAGE =
  'Transcription failed after repeated attempts.';
export const transcriptionTimeLimitMessage = (limit: string): string =>
  `Transcription took longer than the ${limit} limit.`;

/** The model a deployment asks for when nothing says otherwise: Whisper `small`. */
export const DEFAULT_MODEL = 'Systran/faster-whisper-small';

/** How much of the pattern below follows the header: far more than a decoder gives up after. */
const NOISE_BYTES = 8192;

/**
 * An MP3 as far as the type check reads, and no further: the fixture's tag and first frame
 * header, followed by a fixed pattern that is not audio. The API stores it as `audio/mpeg`,
 * and the Whisper service answers these exact bytes with a 415, `Failed to decode audio` —
 * checked against the real service, which is what `UNDECODABLE_REPLY` restates for the fake.
 *
 * A recording that is merely cut short is not this: Whisper transcribes whatever of it decodes.
 */
export const undecodableMp3 = (): Buffer =>
  Buffer.concat([
    fs.readFileSync(fixture('sample.mp3')).subarray(0, 512),
    Buffer.from(Array.from({ length: NOISE_BYTES }, (_, index) => (index * 131 + 7) % 251)),
  ]);

/**
 * Words only the endpoint says. Whatever the API stores, lists, or streams about a failure
 * must not contain them: the reason a user reads is the API's own fixed copy.
 */
export const ENDPOINT_MARKER = 'whisper-internal-marker-7f3a';

/** What the Whisper service answers to audio it cannot decode, with the marker added. */
export const UNDECODABLE_REPLY: TranscriberReply = {
  kind: 'error',
  status: 415,
  body: JSON.stringify({
    detail: `Failed to decode audio. The provided file type is not supported. ${ENDPOINT_MARKER}`,
  }),
};

/** The one handle a spec needs from either worker, reached by token. */
export interface WorkerHandle {
  drain(): Promise<number>;
}

export const fileWorkerOf = (app: INestApplication): WorkerHandle =>
  app.get<WorkerHandle>(MEETING_FILE_WORKER_TOKEN);

export const transcriptionWorkerOf = (app: INestApplication): WorkerHandle =>
  app.get<WorkerHandle>(MEETING_FILE_TRANSCRIPTION_WORKER_TOKEN);

export interface TranscriptionSettings {
  enabled?: boolean;
  /** `ConfigService.set` bypasses the environment contract's floor of thirty seconds. */
  timeLimitSeconds?: number;
}

/**
 * Points an application at the fake and switches the setting. Through `ConfigService.set`,
 * which works only because the worker, the queueing step, and the adapter each ask for their
 * setting when they run rather than once in a constructor.
 */
export function configureTranscription(
  app: INestApplication,
  transcriber: FakeTranscriber,
  { enabled = true, timeLimitSeconds = 720 }: TranscriptionSettings = {},
): void {
  const config = app.get(ConfigService);

  config.set('MEETING_FILES_TRANSCRIPTION_ENABLED', enabled);
  config.set('TRANSCRIPTION_API_URL', transcriber.url);
  // Boot requires one whenever transcription is on, and the adapter refuses to guess; the
  // stand-in endpoint does not care which.
  config.set('TRANSCRIPTION_MODEL', 'Systran/faster-whisper-small');
  config.set('TRANSCRIPTION_TIMEOUT_SECONDS', timeLimitSeconds);
}

export interface TranscriptionSuite {
  transcriber: FakeTranscriber;
  fileWorker(): WorkerHandle;
  transcriptionWorker(): WorkerHandle;
  /** Changes the suite application's settings for the rest of the test. */
  configure(settings: TranscriptionSettings): void;
  upload(
    token: string,
    meetingId: string,
    file: string | Buffer,
    filename?: string,
  ): Promise<MeetingFile>;
  /** Uploads and runs the file's own checks, so it is `ready` — and queued, if it qualifies. */
  uploadReady(
    token: string,
    meetingId: string,
    file: string | Buffer,
    filename?: string,
  ): Promise<MeetingFile>;
  list(token: string, meetingId: string): Promise<MeetingFile[]>;
}

/**
 * What every transcription spec sets up: the fake endpoint for the file, and before each test
 * the setting on, the endpoint answering `TRANSCRIPT`, and the default time limit.
 *
 * Call it at describe scope, after `useApiSuite` — its hooks rely on the application that
 * suite's hooks have already created.
 */
export function useTranscriptionSuite(suite: ApiSuite): TranscriptionSuite {
  const transcriber = new FakeTranscriber();

  beforeAll(() => transcriber.start());
  afterAll(() => transcriber.stop());

  beforeEach(() => {
    transcriber.reset(TRANSCRIPT);
    configureTranscription(suite.app(), transcriber);
  });

  const upload: TranscriptionSuite['upload'] = async (token, meetingId, file, filename) => {
    const response = await suite
      .postFile(meetingFilesUrl(meetingId), token, file, { filename })
      .expect(201);

    return response.body as MeetingFile;
  };

  return {
    transcriber,
    fileWorker: () => fileWorkerOf(suite.app()),
    transcriptionWorker: () => transcriptionWorkerOf(suite.app()),
    configure: (settings) => configureTranscription(suite.app(), transcriber, settings),
    upload,
    uploadReady: async (token, meetingId, file, filename) => {
      const uploaded = await upload(token, meetingId, file, filename);

      await fileWorkerOf(suite.app()).drain();

      return uploaded;
    },
    list: async (token, meetingId) => {
      const response = await suite
        .get(meetingFilesUrl(meetingId))
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      return response.body as MeetingFile[];
    },
  };
}
