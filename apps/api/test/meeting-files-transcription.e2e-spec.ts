import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';

import { ConfigService } from '@nestjs/config';
import type { MeetingFile } from '@repo/shared';

import { StepError } from '../src/modules/meeting-files/processing/step';

import { useApiSuite } from './utils/api-suite';
import {
  EMAIL,
  MEETING_FILE_WORKER_TOKEN,
  OTHER_EMAIL,
  TRANSCRIPTION_PROVIDER_TOKEN,
  meetingFileTranscriptUrl,
  meetingFileUrl,
  meetingFilesDir,
  meetingFilesUrl,
} from './utils/fixtures';
import { messageOf } from './utils/http';
import { findMeetingFileRow } from './utils/meeting-files-table';
import { createMeeting, registerUser } from './utils/meeting-files-suite';

const FIXTURES = path.join(__dirname, 'fixtures');
const fixture = (name: string): string => path.join(FIXTURES, name);

const TRANSCRIPT = 'Good morning, everyone. Shall we start with the engine?';
const FAILURE_MESSAGE = 'The recording could not be transcribed';

interface WorkerHandle {
  drain(): Promise<number>;
}

/**
 * The fake bound in place of the HTTP adapter. It is the port's whole contract: bytes in,
 * text out, and an abort that rejects — which is what lets this spec drive a provider that
 * throws, and one that never answers, without a server.
 */
class FakeProvider {
  /**
   * A real `StepError`, not a look-alike: the worker copies `userMessage` into
   * `failureReason` only for that class, and anything else becomes the generic sentence. A
   * fake that threw a shape-compatible object would pass itself and prove nothing about what
   * the HTTP adapter has to throw.
   */
  behaviour: 'text' | 'throw' | 'hang' = 'text';
  calls: Array<{ contentType: string; bytes: number }> = [];

  async transcribe(stream: Readable, contentType: string, signal: AbortSignal): Promise<string> {
    let bytes = 0;

    for await (const chunk of stream) {
      bytes += (chunk as Buffer).length;
    }

    this.calls.push({ contentType, bytes });

    if (this.behaviour === 'throw') {
      throw new StepError(FAILURE_MESSAGE);
    }

    if (this.behaviour === 'hang') {
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new StepError(FAILURE_MESSAGE)));
      });
    }

    return TRANSCRIPT;
  }
}

const provider = new FakeProvider();

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const objectPath = (meetingId: string, fileId: string, suffix = ''): string =>
  path.join(meetingFilesDir(), meetingId, `${fileId}${suffix}`);

describe('the transcription step', () => {
  const suite = useApiSuite({
    overrides: [{ token: TRANSCRIPTION_PROVIDER_TOKEN, value: provider }],
  });

  const worker = (): WorkerHandle => suite.app().get<WorkerHandle>(MEETING_FILE_WORKER_TOKEN);
  const config = (): ConfigService => suite.app().get(ConfigService);

  /** The step asks `ConfigService` when it runs, which is what lets a spec flip the flag in place. */
  const enableTranscription = (seconds = 600): void => {
    config().set('MEETING_FILES_TRANSCRIPTION_ENABLED', true);
    config().set('TRANSCRIPTION_TIMEOUT_SECONDS', seconds);
  };

  const upload = async (token: string, meetingId: string, file: string): Promise<MeetingFile> => {
    const response = await suite
      .postFile(meetingFilesUrl(meetingId), token, fixture(file))
      .expect(201);

    return response.body as MeetingFile;
  };

  beforeEach(() => {
    provider.behaviour = 'text';
    provider.calls = [];
    config().set('MEETING_FILES_TRANSCRIPTION_ENABLED', false);
    config().set('TRANSCRIPTION_TIMEOUT_SECONDS', 600);
  });

  it('leaves a recording alone while the flag is off — ready, with no transcript', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const file = await upload(host.token, meeting.id, 'sample.mp3');

    await expect(worker().drain()).resolves.toBe(1);

    await expect(findMeetingFileRow(suite.prisma(), file.id)).resolves.toMatchObject({
      status: 'ready',
      transcript_key: null,
      failure_reason: null,
    });
    expect(provider.calls).toEqual([]);
    expect(fs.existsSync(objectPath(meeting.id, file.id, '.transcript.txt'))).toBe(false);

    // And the contract says nothing about a transcript that does not exist.
    const listed = await suite
      .get(meetingFilesUrl(meeting.id))
      .set('Authorization', `Bearer ${host.token}`)
      .expect(200);
    expect(listed.body).toEqual([
      expect.not.objectContaining({ transcriptPath: expect.anything() }),
    ]);
  });

  it('transcribes a recording with the flag on, and serves the text from its own route', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const file = await upload(host.token, meeting.id, 'sample.mp3');
    enableTranscription();

    await expect(worker().drain()).resolves.toBe(1);

    const row = await findMeetingFileRow(suite.prisma(), file.id);
    expect(row).toMatchObject({
      status: 'ready',
      transcript_key: `${meeting.id}/${file.id}.transcript.txt`,
      failure_reason: null,
      leased_until: null,
    });
    // The whole object reached the provider, streamed rather than buffered.
    expect(provider.calls).toEqual([
      { contentType: 'audio/mpeg', bytes: fs.statSync(fixture('sample.mp3')).size },
    ]);
    expect(fs.readFileSync(objectPath(meeting.id, file.id, '.transcript.txt'), 'utf8')).toBe(
      TRANSCRIPT,
    );

    const response = await suite
      .get(meetingFileTranscriptUrl(meeting.id, file.id))
      .set('Authorization', `Bearer ${host.token}`)
      .expect(200);

    expect(response.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['content-disposition']).toContain('inline');
    expect(response.text).toBe(TRANSCRIPT);

    // And the list now says where to find it.
    const listed = await suite
      .get(meetingFilesUrl(meeting.id))
      .set('Authorization', `Bearer ${host.token}`)
      .expect(200);
    expect(listed.body).toEqual([
      expect.objectContaining({
        transcriptPath: `/meetings/${meeting.id}/files/${file.id}/transcript`,
      }),
    ]);
  });

  it('skips a file that is neither audio nor video, even with the flag on', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const file = await upload(host.token, meeting.id, 'sample.pdf');
    enableTranscription();

    await expect(worker().drain()).resolves.toBe(1);

    await expect(findMeetingFileRow(suite.prisma(), file.id)).resolves.toMatchObject({
      status: 'ready',
      transcript_key: null,
      failure_reason: null,
    });
    expect(provider.calls).toEqual([]);
  });

  it('fails the file with the step’s reason when the provider throws', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const file = await upload(host.token, meeting.id, 'sample.mp3');
    enableTranscription();
    provider.behaviour = 'throw';

    await expect(worker().drain()).resolves.toBe(1);

    await expect(findMeetingFileRow(suite.prisma(), file.id)).resolves.toMatchObject({
      status: 'failed',
      failure_reason: FAILURE_MESSAGE,
      transcript_key: null,
      // The checksum verify produced is still true of the bytes, so it is kept.
      checksum: expect.any(String),
    });
    expect(fs.existsSync(objectPath(meeting.id, file.id, '.transcript.txt'))).toBe(false);

    await suite
      .get(meetingFileTranscriptUrl(meeting.id, file.id))
      .set('Authorization', `Bearer ${host.token}`)
      .expect(404);
  });

  it('renews the lease while a slow provider runs, then fails on the timeout', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const file = await upload(host.token, meeting.id, 'sample.mp3');
    // Three seconds against the suite's five second lease, which beats every 1.7s: long
    // enough to watch a renewal happen, short enough for a test to wait out. The environment
    // contract's floor is thirty; `set` is runtime configuration and bypasses it, which is
    // the only way a spec can exercise the timeout at all.
    enableTranscription(3);
    provider.behaviour = 'hang';

    const drained = worker().drain();
    await settle(600);

    const early = await findMeetingFileRow(suite.prisma(), file.id);
    expect(early.status).toBe('processing');

    await settle(1_800);

    const later = await findMeetingFileRow(suite.prisma(), file.id);
    // The lease moved while one step was still running, which only the heartbeat does.
    expect(later.status).toBe('processing');
    expect(Date.parse(later.leased_until ?? '')).toBeGreaterThan(
      Date.parse(early.leased_until ?? ''),
    );

    await expect(drained).resolves.toBe(1);

    await expect(findMeetingFileRow(suite.prisma(), file.id)).resolves.toMatchObject({
      status: 'failed',
      failure_reason: FAILURE_MESSAGE,
      leased_until: null,
    });
  }, 30_000);

  it('purges the transcript along with the object and the thumbnail', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const file = await upload(host.token, meeting.id, 'sample.mp3');
    enableTranscription();

    await expect(worker().drain()).resolves.toBe(1);
    expect(fs.existsSync(objectPath(meeting.id, file.id, '.transcript.txt'))).toBe(true);

    await suite
      .delete(meetingFileUrl(meeting.id, file.id))
      .set('Authorization', `Bearer ${host.token}`)
      .expect(204);
    await expect(worker().drain()).resolves.toBe(1);

    await expect(findMeetingFileRow(suite.prisma(), file.id)).resolves.toMatchObject({
      status: 'deleted',
      purged_at: expect.any(String),
    });
    expect(fs.existsSync(objectPath(meeting.id, file.id))).toBe(false);
    expect(fs.existsSync(objectPath(meeting.id, file.id, '.transcript.txt'))).toBe(false);
  });

  it('answers 404 to a stranger, and to a file with no transcript', async () => {
    const host = await registerUser(suite, EMAIL);
    const stranger = await registerUser(suite, OTHER_EMAIL);
    const meeting = await createMeeting(suite, host);
    const file = await upload(host.token, meeting.id, 'sample.mp3');

    await expect(worker().drain()).resolves.toBe(1);

    const notTranscribed = await suite
      .get(meetingFileTranscriptUrl(meeting.id, file.id))
      .set('Authorization', `Bearer ${host.token}`)
      .expect(404);
    expect(messageOf(notTranscribed)).toBe('Transcript not found');

    const outsider = await suite
      .get(meetingFileTranscriptUrl(meeting.id, file.id))
      .set('Authorization', `Bearer ${stranger.token}`)
      .expect(404);
    expect(messageOf(outsider)).toBe('Meeting not found');

    await suite.get(meetingFileTranscriptUrl(meeting.id, file.id)).expect(401);
  });
});
