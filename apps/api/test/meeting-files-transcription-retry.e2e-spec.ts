import type { MeetingFile } from '@repo/shared';

import { useApiSuite } from './utils/api-suite';
import {
  EMAIL,
  OTHER_EMAIL,
  THIRD_EMAIL,
  meetingFileContentUrl,
  meetingFileEventsUrl,
  meetingFileTranscriptUrl,
  meetingFileTranscriptionRetryUrl,
  meetingFileUrl,
} from './utils/fixtures';
import type { TranscriberReply } from './utils/fake-transcriber';
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
import { openSse } from './utils/sse';
import type { SseClient } from './utils/sse';
import {
  TRANSCRIPT,
  TRANSCRIPTION_REPEATED_FAILURE_MESSAGE,
  fixture,
  useTranscriptionSuite,
} from './utils/transcription-suite';

const MINUTE_MS = 60_000;
const NOT_FAILED_MESSAGE = 'Only a failed transcription can be retried';

/** The endpoint while Whisper is down: every recording sent to it comes back an error. */
const ENDPOINT_DOWN: TranscriberReply = { kind: 'error', status: 503, body: 'Unavailable' };

/** The `MeetingFile` the next `file` event carried, skipping any heartbeat before it. */
const fileOf = async (client: SseClient): Promise<MeetingFile> =>
  JSON.parse((await client.nextOf('file')).data) as MeetingFile;

describe('POST /api/meetings/:id/files/:fileId/transcription/retry', () => {
  const suite = useApiSuite();
  const transcription = useTranscriptionSuite(suite);
  const { transcriber } = transcription;
  const open: SseClient[] = [];

  afterEach(() => {
    for (const client of open.splice(0)) {
      client.close();
    }
  });

  const get = (url: string, token: string) =>
    suite.get(url).set('Authorization', `Bearer ${token}`);

  const retry = (token: string, meetingId: string, fileId: string) =>
    suite
      .post(meetingFileTranscriptionRetryUrl(meetingId, fileId), {})
      .set('Authorization', `Bearer ${token}`);

  const rowOf = (file: MeetingFile) => findMeetingFileRow(suite.prisma(), file.id);

  /**
   * Uploads an MP3 and drains both workers with the endpoint down: the shortest route to a
   * `failed` transcription. The endpoint then answers again — Whisper has been started.
   */
  const uploadAndFailTranscription = async (
    token: string,
    meetingId: string,
  ): Promise<MeetingFile> => {
    const file = await transcription.uploadReady(token, meetingId, fixture('sample.mp3'));
    transcriber.reply = () => ENDPOINT_DOWN;
    await expect(transcription.transcriptionWorker().drain()).resolves.toBe(1);
    await expect(rowOf(file)).resolves.toMatchObject({
      transcription_status: FAILED,
      transcription_attempts: 1,
    });
    transcriber.reply = () => ({ kind: 'text', text: TRANSCRIPT });

    return file;
  };

  /** A drain that ends the retried recording Transcribed, with its transcript served. */
  const expectTranscribedAfterDrain = async (token: string, file: MeetingFile): Promise<void> => {
    await expect(transcription.transcriptionWorker().drain()).resolves.toBe(1);
    await expect(rowOf(file)).resolves.toMatchObject({
      status: 'ready',
      transcription_status: TRANSCRIBED,
      transcription_failure_reason: null,
      // The first claim since the retry, not one more on top of those before it.
      transcription_attempts: 1,
      transcript_key: `${file.meetingId}/${file.id}.transcript.txt`,
    });
    const transcript = await get(meetingFileTranscriptUrl(file.meetingId, file.id), token);
    expect(transcript.status).toBe(200);
    expect(transcript.text).toBe(TRANSCRIPT);
  };

  it('queues the uploader’s failed transcription again, and a drain ends it Transcribed', async () => {
    const host = await registerUser(suite, EMAIL);
    const uploader = await registerUser(suite, OTHER_EMAIL);
    const meeting = await createMeeting(suite, host, [uploader.id]);
    const file = await uploadAndFailTranscription(uploader.token, meeting.id);

    const response = await retry(uploader.token, meeting.id, file.id).expect(200);

    expect(response.body).toMatchObject({ status: 'ready', transcriptionStatus: 'queued' });
    // A queued transcription carries neither the old reason nor a transcript.
    expect(response.body).not.toHaveProperty('transcriptionFailureReason');
    expect(response.body).not.toHaveProperty('transcriptPath');
    await expect(rowOf(file)).resolves.toMatchObject({
      status: 'ready',
      transcription_status: QUEUED,
      transcription_attempts: 0,
      transcription_failure_reason: null,
      transcription_leased_until: null,
      transcript_key: null,
    });
    // The file as written: what the caller was answered with is what the list now reports.
    await expect(transcription.list(uploader.token, meeting.id)).resolves.toEqual([response.body]);
    // The retry is the transcription's alone: the file was downloadable before it and still is.
    await get(meetingFileContentUrl(meeting.id, file.id), uploader.token).expect(200);

    await expectTranscribedAfterDrain(uploader.token, file);
    // One request that failed, and the one the retry asked for.
    expect(transcriber.calls).toHaveLength(2);
  });

  it('lets the host retry a participant’s, and carries the edge on the stream', async () => {
    const host = await registerUser(suite, EMAIL);
    const uploader = await registerUser(suite, OTHER_EMAIL);
    const meeting = await createMeeting(suite, host, [uploader.id]);
    const file = await uploadAndFailTranscription(uploader.token, meeting.id);
    // Opened after the failure, and by somebody else: every viewer learns of the retry.
    const client = await openSse(suite, meetingFileEventsUrl(meeting.id), uploader.token);
    open.push(client);

    const response = await retry(host.token, meeting.id, file.id).expect(200);

    const queued = await fileOf(client);
    expect(queued).toEqual(response.body);
    expect(queued).toMatchObject({ id: file.id, status: 'ready', transcriptionStatus: 'queued' });

    await expectTranscribedAfterDrain(host.token, file);
    await expect(fileOf(client)).resolves.toMatchObject({ transcriptionStatus: 'transcribing' });
    await expect(fileOf(client)).resolves.toMatchObject({ transcriptionStatus: 'transcribed' });
  });

  it('starts the claim count again, so a transcription failed at the cap is run on the retry', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const file = await transcription.uploadReady(host.token, meeting.id, fixture('sample.mp3'));
    // Three workers died holding this recording; the fourth claim fails it without running it.
    await setMeetingFileTranscriptionState(suite.prisma(), file.id, {
      transcription_status: TRANSCRIBING,
      transcription_attempts: 3,
      transcription_leased_until: new Date(Date.now() - MINUTE_MS),
    });
    await expect(transcription.transcriptionWorker().drain()).resolves.toBe(1);
    await expect(rowOf(file)).resolves.toMatchObject({
      transcription_status: FAILED,
      transcription_failure_reason: TRANSCRIPTION_REPEATED_FAILURE_MESSAGE,
      transcription_attempts: 4,
    });

    await retry(host.token, meeting.id, file.id).expect(200);

    // Zero, not four: a retry is a fresh chance, not a fifth claim against the cap of three.
    await expect(rowOf(file)).resolves.toMatchObject({
      transcription_status: QUEUED,
      transcription_attempts: 0,
    });
    await expectTranscribedAfterDrain(host.token, file);
  });

  it('answers 404 to another participant and to a stranger, leaving the row alone', async () => {
    const host = await registerUser(suite, EMAIL);
    const participant = await registerUser(suite, OTHER_EMAIL);
    const stranger = await registerUser(suite, THIRD_EMAIL);
    const meeting = await createMeeting(suite, host, [participant.id]);
    const file = await uploadAndFailTranscription(host.token, meeting.id);
    const before = await rowOf(file);

    // Neither its uploader nor the host: the file exists for them, and the retry does not.
    const inside = await retry(participant.token, meeting.id, file.id).expect(404);
    const outside = await retry(stranger.token, meeting.id, file.id).expect(404);

    expect(messageOf(inside)).toBe('File not found');
    expect(messageOf(outside)).toBe('Meeting not found');
    await expect(rowOf(file)).resolves.toEqual(before);
  });

  it('answers 409 for a transcription that is not failed, whatever else it is', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const expectConflict = async (file: MeetingFile, status: string | null): Promise<void> => {
      const before = await rowOf(file);
      expect(before.transcription_status).toBe(status);

      const response = await retry(host.token, meeting.id, file.id).expect(409);

      expect(messageOf(response)).toBe(NOT_FAILED_MESSAGE);
      await expect(rowOf(file)).resolves.toEqual(before);
    };
    const pdf = await transcription.uploadReady(host.token, meeting.id, fixture('sample.pdf'));
    const mp3 = await transcription.uploadReady(host.token, meeting.id, fixture('sample.mp3'));

    // A file that has no transcription at all, and a recording still waiting for its first.
    await expectConflict(pdf, null);
    await expectConflict(mp3, QUEUED);

    // In a worker's hands: a retry must not pull a running transcription back to the queue.
    await setMeetingFileTranscriptionState(suite.prisma(), mp3.id, {
      transcription_status: TRANSCRIBING,
      transcription_attempts: 1,
      transcription_leased_until: new Date(Date.now() + MINUTE_MS),
    });
    await expectConflict(mp3, TRANSCRIBING);

    await setMeetingFileTranscriptionState(suite.prisma(), mp3.id, {
      transcription_status: TRANSCRIBED,
      transcription_leased_until: null,
    });
    await expectConflict(mp3, TRANSCRIBED);
  });

  it('refuses an anonymous caller, a malformed file id, and a deleted file', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const file = await uploadAndFailTranscription(host.token, meeting.id);

    await suite.post(meetingFileTranscriptionRetryUrl(meeting.id, file.id), {}).expect(401);
    await retry(host.token, meeting.id, 'not-a-uuid').expect(400);

    await suite
      .delete(meetingFileUrl(meeting.id, file.id))
      .set('Authorization', `Bearer ${host.token}`)
      .expect(204);
    const response = await retry(host.token, meeting.id, file.id).expect(404);

    expect(messageOf(response)).toBe('File not found');
    await expect(rowOf(file)).resolves.toMatchObject({
      status: 'deleted',
      transcription_status: FAILED,
    });
  });
});
