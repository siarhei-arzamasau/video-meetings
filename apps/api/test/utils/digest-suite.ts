import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MeetingDigest, MeetingFile } from '@repo/shared';

import type { ApiSuite } from './api-suite';
import type { FakeClaudeAgent } from './fake-claude-agent';
import {
  MEETING_DIGEST_WORKER_TOKEN,
  PENDING_DIGEST_REQUESTS_TOKEN,
  meetingDigestUrl,
} from './fixtures';
import { fixture } from './transcription-suite';
import type { TranscriptionSuite, WorkerHandle } from './transcription-suite';

/**
 * The failure copy from `@repo/shared`, restated for the reason `fixtures.ts` restates every
 * other sentence: rewording one must fail a spec rather than quietly pass it.
 */
export const DIGEST_FAILED_MESSAGE = 'The digest could not be generated.';
export const DIGEST_REPEATED_FAILURE_MESSAGE =
  'The digest could not be generated after repeated attempts.';
export const DIGEST_TOO_LONG_MESSAGE =
  'The recordings of this meeting are too long to turn into one digest.';
export const digestTimeLimitMessage = (limit: string): string =>
  `Generating the digest took longer than the ${limit} limit.`;

/** The most transcript text one generation carries, restated: a relaxed cap must fail a spec. */
export const MAX_DIGEST_TRANSCRIPT_CHARACTERS = 1_700_000;

export const digestWorkerOf = (app: INestApplication): WorkerHandle =>
  app.get<WorkerHandle>(MEETING_DIGEST_WORKER_TOKEN);

export interface DigestSettings {
  enabled?: boolean;
  /** `ConfigService.set` bypasses the environment contract's floor of thirty seconds. */
  timeLimitSeconds?: number;
}

/**
 * Switches an application's digest setting. Through `ConfigService.set`, which works only
 * because the event handler and the worker each ask for their setting when they run.
 */
export function configureDigest(
  app: INestApplication,
  { enabled = true, timeLimitSeconds = 240 }: DigestSettings = {},
): void {
  const config = app.get(ConfigService);

  config.set('MEETING_DIGEST_ENABLED', enabled);
  config.set('MEETING_DIGEST_TIMEOUT_SECONDS', timeLimitSeconds);
}

export interface DigestSuite {
  claude: FakeClaudeAgent;
  worker(): WorkerHandle;
  /** Resolves once every request a transcribed recording started has been written. */
  requested(): Promise<void>;
  /** Changes the suite application's settings for the rest of the test. */
  configure(settings: DigestSettings): void;
  read(token: string, meetingId: string): Promise<MeetingDigest>;
  /**
   * Uploads a recording and takes it all the way to Transcribed with `transcript` as what was
   * said in it — and to its request for a digest having been written, if it made one.
   */
  transcribe(token: string, meetingId: string, transcript: string): Promise<MeetingFile>;
}

/**
 * What every digest spec sets up: before each test the fake Claude answering with the digest
 * of whatever it is sent, the setting on, and the default time limit.
 *
 * Call it at describe scope, after `useApiSuite` — which must have been given
 * `claude.override()`, or the application would hold the real service — and after
 * `useTranscriptionSuite`, whose fake Whisper is where the transcripts come from.
 */
export function useDigestSuite(
  suite: ApiSuite,
  transcription: TranscriptionSuite,
  claude: FakeClaudeAgent,
): DigestSuite {
  beforeEach(() => {
    claude.reset();
    configureDigest(suite.app());
  });

  const requested = (): Promise<void> =>
    suite.app().get<{ settled(): Promise<void> }>(PENDING_DIGEST_REQUESTS_TOKEN).settled();

  return {
    claude,
    worker: () => digestWorkerOf(suite.app()),
    requested,
    configure: (settings) => configureDigest(suite.app(), settings),
    read: async (token, meetingId) => {
      const response = await suite
        .get(meetingDigestUrl(meetingId))
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      return response.body as MeetingDigest;
    },
    transcribe: async (token, meetingId, transcript) => {
      transcription.transcriber.reply = () => ({ kind: 'text', text: transcript });

      const file = await transcription.uploadReady(token, meetingId, fixture('sample.mp3'));

      await transcription.transcriptionWorker().drain();
      await requested();

      return file;
    },
  };
}
