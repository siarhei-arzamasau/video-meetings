import fs from 'node:fs';

import type { INestApplication } from '@nestjs/common';
import type { MeetingFile } from '@repo/shared';

import { useApiSuite } from './utils/api-suite';
import { createTestApp } from './utils/create-test-app';
import { EMAIL, meetingFileTranscriptUrl, meetingFileUrl } from './utils/fixtures';
import { messageOf } from './utils/http';
import {
  FAILED,
  QUEUED,
  TRANSCRIBED,
  TRANSCRIBING,
  setMeetingFileTranscriptionState,
} from './utils/meeting-file-transcription-table';
import { findMeetingFileRow } from './utils/meeting-files-table';
import { createMeeting, registerUser } from './utils/meeting-files-suite';
import type { RegisteredUser } from './utils/meeting-files-suite';
import {
  TRANSCRIPT,
  TRANSCRIPTION_REPEATED_FAILURE_MESSAGE,
  configureTranscription,
  fixture,
  objectPath,
  transcriptPath,
  transcriptionWorkerOf,
  useTranscriptionSuite,
} from './utils/transcription-suite';

const MINUTE_MS = 60_000;

/**
 * What happens to a transcription when the thing doing it goes away: a process that shuts
 * down, a process that dies, and a file deleted from under it. None of them may leave a
 * recording in Transcribing for ever, and only repeated deaths may fail one. And what a
 * delete leaves of a transcript, whenever it was stored: nothing.
 */
describe('a transcription that is interrupted', () => {
  const suite = useApiSuite();
  const transcription = useTranscriptionSuite(suite);
  const { transcriber } = transcription;
  /** Second applications a test started and has not yet shut down itself. */
  const replicas: INestApplication[] = [];

  afterEach(async () => {
    await Promise.all(replicas.splice(0).map((replica) => replica.close()));
  });

  const queuedRecording = async (): Promise<{ host: RegisteredUser; file: MeetingFile }> => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const file = await transcription.uploadReady(host.token, meeting.id, fixture('sample.mp3'));

    return { host, file };
  };

  /** The claim a worker that died left behind: transcribing, counted, its lease as given. */
  const abandonClaim = (fileId: string, attempts: number, leaseEndsInMs: number): Promise<void> =>
    setMeetingFileTranscriptionState(suite.prisma(), fileId, {
      transcription_status: TRANSCRIBING,
      transcription_attempts: attempts,
      transcription_leased_until: new Date(Date.now() + leaseEndsInMs),
    });

  it('hands the claim back on a graceful shutdown, and another process finishes it', async () => {
    const { file } = await queuedRecording();
    const replica = await createTestApp();
    replicas.push(replica);
    configureTranscription(replica, transcriber);
    transcriber.reply = () => ({ kind: 'hold' });

    const drained = transcriptionWorkerOf(replica).drain();
    await transcriber.arrived(1);
    await expect(findMeetingFileRow(suite.prisma(), file.id)).resolves.toMatchObject({
      transcription_status: TRANSCRIBING,
      transcription_attempts: 1,
    });

    await replicas.pop()?.close();
    await expect(drained).resolves.toBe(1);

    // Queued again and not counted: no number of deploys can fail a recording.
    await expect(findMeetingFileRow(suite.prisma(), file.id)).resolves.toMatchObject({
      status: 'ready',
      transcription_status: QUEUED,
      transcription_attempts: 0,
      transcription_leased_until: null,
      transcription_failure_reason: null,
      transcript_key: null,
    });
    expect(transcriber.hangUps).toBe(1);

    transcriber.reply = () => ({ kind: 'text', text: TRANSCRIPT });
    await expect(transcription.transcriptionWorker().drain()).resolves.toBe(1);

    await expect(findMeetingFileRow(suite.prisma(), file.id)).resolves.toMatchObject({
      transcription_status: TRANSCRIBED,
      transcription_attempts: 1,
    });
  });

  it('reclaims a transcription whose worker died, once its lease has lapsed', async () => {
    const { file } = await queuedRecording();
    await abandonClaim(file.id, 1, MINUTE_MS);

    // The lease still stands: for all anyone knows, that worker is alive and working.
    await expect(transcription.transcriptionWorker().drain()).resolves.toBe(0);
    await expect(findMeetingFileRow(suite.prisma(), file.id)).resolves.toMatchObject({
      transcription_status: TRANSCRIBING,
      transcription_attempts: 1,
    });

    await abandonClaim(file.id, 1, -MINUTE_MS);
    await expect(transcription.transcriptionWorker().drain()).resolves.toBe(1);

    // A crash counts, unlike a shutdown: this was the second claim.
    await expect(findMeetingFileRow(suite.prisma(), file.id)).resolves.toMatchObject({
      status: 'ready',
      transcription_status: TRANSCRIBED,
      transcription_attempts: 2,
      transcription_leased_until: null,
    });
  });

  it('fails a transcription claimed a fourth time without sending it anywhere', async () => {
    const { host, file } = await queuedRecording();
    await abandonClaim(file.id, 3, -MINUTE_MS);

    await expect(transcription.transcriptionWorker().drain()).resolves.toBe(1);

    await expect(findMeetingFileRow(suite.prisma(), file.id)).resolves.toMatchObject({
      status: 'ready',
      transcription_status: FAILED,
      transcription_failure_reason: TRANSCRIPTION_REPEATED_FAILURE_MESSAGE,
      transcription_attempts: 4,
      transcription_leased_until: null,
    });
    expect(transcriber.calls).toEqual([]);
    await expect(transcription.list(host.token, file.meetingId)).resolves.toEqual([
      expect.objectContaining({
        status: 'ready',
        transcriptionStatus: 'failed',
        transcriptionFailureReason: TRANSCRIPTION_REPEATED_FAILURE_MESSAGE,
      }),
    ]);
  });

  describe('a deleted recording', () => {
    /** Deletes it and runs the purge, which removes whatever is on disk at that moment. */
    const deleteAndPurge = async (host: RegisteredUser, file: MeetingFile): Promise<void> => {
      await suite
        .delete(meetingFileUrl(file.meetingId, file.id))
        .set('Authorization', `Bearer ${host.token}`)
        .expect(204);
      await expect(transcription.fileWorker().drain()).resolves.toBe(1);
    };

    const deleteMidRun = async (): Promise<{
      host: RegisteredUser;
      file: MeetingFile;
      drained: Promise<number>;
    }> => {
      const { host, file } = await queuedRecording();
      transcriber.reply = () => ({ kind: 'hold' });
      const drained = transcription.transcriptionWorker().drain();
      await transcriber.arrived(1);
      // The purge runs while the transcription is still in flight.
      await deleteAndPurge(host, file);

      return { host, file, drained };
    };

    const expectNothingLeft = async (host: RegisteredUser, file: MeetingFile): Promise<void> => {
      await expect(findMeetingFileRow(suite.prisma(), file.id)).resolves.toMatchObject({
        status: 'deleted',
        purged_at: expect.any(String),
      });
      expect(fs.existsSync(objectPath(file.meetingId, file.id))).toBe(false);
      expect(fs.existsSync(transcriptPath(file.meetingId, file.id))).toBe(false);
      await expect(transcription.list(host.token, file.meetingId)).resolves.toEqual([]);

      const transcript = await suite
        .get(meetingFileTranscriptUrl(file.meetingId, file.id))
        .set('Authorization', `Bearer ${host.token}`);
      expect(transcript.status).toBe(404);
      expect(messageOf(transcript)).toBe('File not found');
    };

    it('loses a transcript stored before the delete, at the purge', async () => {
      const { host, file } = await queuedRecording();
      await transcription.transcriptionWorker().drain();
      expect(fs.readFileSync(transcriptPath(file.meetingId, file.id), 'utf8')).toBe(TRANSCRIPT);

      await deleteAndPurge(host, file);

      await expectNothingLeft(host, file);
    });

    it('loses a transcript that arrives after the purge, and the URL is a 404', async () => {
      const { host, file, drained } = await deleteMidRun();

      // The worker writes the answer, loses the race for the row, and removes what it wrote.
      transcriber.release(TRANSCRIPT);
      await expect(drained).resolves.toBe(1);

      await expectNothingLeft(host, file);
      await expect(findMeetingFileRow(suite.prisma(), file.id)).resolves.toMatchObject({
        transcript_key: null,
      });
    });

    it('stops transcribing when it finds the claim gone, rather than waiting on the endpoint', async () => {
      const { host, file, drained } = await deleteMidRun();

      // Nothing answers. The lease renewal, a third of the run's five second lease later,
      // finds the file is no longer ready and hangs up.
      await expect(drained).resolves.toBe(1);

      expect(transcriber.hangUps).toBe(1);
      await expectNothingLeft(host, file);
    }, 15_000);
  });
});
