import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MeetingDigest, MeetingFile } from '@repo/shared';
import type request from 'supertest';

import type { ApiSuite } from './api-suite';
import type { FakeClaudeAgent } from './fake-claude-agent';
import {
  MEETING_DIGEST_WORKER_TOKEN,
  PENDING_DIGEST_REQUESTS_TOKEN,
  meetingDigestGenerationUrl,
  meetingDigestUrl,
  meetingFileEventsUrl,
  meetingFileUrl,
} from './fixtures';
import { openSse } from './sse';
import type { SseClient } from './sse';
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

/** The request route's refusals, restated like the copy above. */
export const DIGEST_SWITCHED_OFF_MESSAGE = 'Meeting digests are switched off';
export const DIGEST_UNDER_WAY_MESSAGE = 'A digest is already queued or being generated';
export const DIGEST_CURRENT_MESSAGE = 'The digest already covers every transcribed recording';
export const DIGEST_NO_RECORDING_MESSAGE =
  'The meeting has no transcribed recording to generate a digest from';

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

/** The `event:` name a digest is sent under on the files stream, restated like the copy above. */
export const DIGEST_EVENT = 'digest';

/** One meeting's stream, read for what it says about the digest. */
export interface DigestStream {
  /**
   * The digest the next `digest` event carried, skipping whatever else the stream sent —
   * and held to what every one of them owes a page that keeps the higher of two: its
   * meeting, and a version above the last this stream was sent.
   */
  next(): Promise<MeetingDigest>;
  /** Resolves when the stream sends no `digest` event for `forMs`, and rejects if it does. */
  quiet(forMs?: number): Promise<void>;
}

export interface DigestSuite {
  claude: FakeClaudeAgent;
  worker(): WorkerHandle;
  /**
   * Resolves once everything a file's event started has been written and announced: the
   * request a transcribed recording makes, and what a deleted one does to the digest.
   */
  requested(): Promise<void>;
  /** Changes the suite application's settings for the rest of the test. */
  configure(settings: DigestSettings): void;
  read(token: string, meetingId: string): Promise<MeetingDigest>;
  /**
   * "Generate now" — Generate and Retry are this one request. The response is the caller's
   * to hold to a status: most of what a spec says about this route is who is refused.
   */
  ask(token: string, meetingId: string): request.Test;
  /**
   * Uploads a recording and takes it all the way to Transcribed with `transcript` as what was
   * said in it — and to its request for a digest having been written, if it made one.
   */
  transcribe(token: string, meetingId: string, transcript: string): Promise<MeetingFile>;
  /** Deletes a file, and returns once the digest has followed it. */
  remove(token: string, meetingId: string, fileId: string): Promise<void>;
  /** Opens the meeting's files stream, closed again after the test. */
  watch(token: string, meetingId: string): Promise<DigestStream>;
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
  const open: SseClient[] = [];

  beforeEach(() => {
    claude.reset();
    configureDigest(suite.app());
  });

  afterEach(() => {
    for (const client of open.splice(0)) {
      client.close();
    }
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
    ask: (token, meetingId) =>
      suite.post(meetingDigestGenerationUrl(meetingId), {}).set('Authorization', `Bearer ${token}`),
    transcribe: async (token, meetingId, transcript) => {
      transcription.transcriber.reply = () => ({ kind: 'text', text: transcript });

      const file = await transcription.uploadReady(token, meetingId, fixture('sample.mp3'));

      await transcription.transcriptionWorker().drain();
      await requested();

      return file;
    },
    remove: async (token, meetingId, fileId) => {
      await suite
        .delete(meetingFileUrl(meetingId, fileId))
        .set('Authorization', `Bearer ${token}`)
        .expect(204);
      await requested();
    },
    watch: async (token, meetingId) => {
      const client = await openSse(suite, meetingFileEventsUrl(meetingId), token);
      let lastVersion = 0;

      open.push(client);

      return {
        next: async () => {
          const digest = JSON.parse((await client.nextOf(DIGEST_EVENT)).data) as MeetingDigest;

          expect(digest.meetingId).toBe(meetingId);
          expect(digest.version).toBeGreaterThan(lastVersion);
          lastVersion = digest.version;

          return digest;
        },
        quiet: async (forMs = 300) => {
          await expect(client.nextOf(DIGEST_EVENT, forMs)).rejects.toThrow('No event within');
        },
      };
    },
  };
}
