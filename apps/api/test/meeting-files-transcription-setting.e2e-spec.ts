import { useApiSuite } from './utils/api-suite';
import {
  EMAIL,
  meetingFileTranscriptUrl,
  meetingFileTranscriptionRetryUrl,
} from './utils/fixtures';
import { FAILED, QUEUED, TRANSCRIBED } from './utils/meeting-file-transcription-table';
import { findMeetingFileRow } from './utils/meeting-files-table';
import { createMeeting, registerUser } from './utils/meeting-files-suite';
import type { RegisteredUser } from './utils/meeting-files-suite';
import {
  TRANSCRIPT,
  TRANSCRIPTION_FAILED_MESSAGE,
  UNDECODABLE_REPLY,
  fixture,
  undecodableMp3,
  useTranscriptionSuite,
} from './utils/transcription-suite';

/**
 * `MEETING_FILES_TRANSCRIPTION_ENABLED` decides whether new work starts, and nothing else:
 * switching it off neither erases what is stored nor fails what is waiting.
 */
describe('the transcription setting', () => {
  const suite = useApiSuite();
  const transcription = useTranscriptionSuite(suite);
  const { transcriber } = transcription;

  const setUp = async (): Promise<{ host: RegisteredUser; meetingId: string }> => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);

    return { host, meetingId: meeting.id };
  };

  it('queues nothing while it is off: a recording is ready with no status, as before', async () => {
    const { host, meetingId } = await setUp();
    transcription.configure({ enabled: false });
    const file = await transcription.upload(host.token, meetingId, fixture('sample.mp3'));

    await expect(transcription.fileWorker().drain()).resolves.toBe(1);
    await expect(transcription.transcriptionWorker().drain()).resolves.toBe(0);

    await expect(findMeetingFileRow(suite.prisma(), file.id)).resolves.toMatchObject({
      status: 'ready',
      transcription_status: null,
      transcription_attempts: 0,
      transcript_key: null,
    });
    await expect(transcription.list(host.token, meetingId)).resolves.toEqual([
      { ...file, status: 'ready', processedAt: expect.any(String) },
    ]);
    expect(transcriber.calls).toEqual([]);
  });

  it('never queues a recording that was processed while it was off', async () => {
    const { host, meetingId } = await setUp();
    transcription.configure({ enabled: false });
    const file = await transcription.uploadReady(host.token, meetingId, fixture('sample.mp3'));

    transcription.configure({ enabled: true });
    await expect(transcription.fileWorker().drain()).resolves.toBe(0);
    await expect(transcription.transcriptionWorker().drain()).resolves.toBe(0);

    await expect(findMeetingFileRow(suite.prisma(), file.id)).resolves.toMatchObject({
      status: 'ready',
      transcription_status: null,
    });
    const [listed] = await transcription.list(host.token, meetingId);
    expect(listed).not.toHaveProperty('transcriptionStatus');
    expect(transcriber.calls).toEqual([]);
  });

  it('leaves a queued recording untouched while it is off, and transcribes it once it is back on', async () => {
    const { host, meetingId } = await setUp();
    const file = await transcription.uploadReady(host.token, meetingId, fixture('sample.mp3'));

    transcription.configure({ enabled: false });
    await expect(transcription.transcriptionWorker().drain()).resolves.toBe(0);

    await expect(findMeetingFileRow(suite.prisma(), file.id)).resolves.toMatchObject({
      status: 'ready',
      transcription_status: QUEUED,
      transcription_attempts: 0,
      transcription_leased_until: null,
    });
    // Still reported: the status is what is stored, whatever the setting says today.
    await expect(transcription.list(host.token, meetingId)).resolves.toEqual([
      expect.objectContaining({ id: file.id, transcriptionStatus: 'queued' }),
    ]);
    expect(transcriber.calls).toEqual([]);

    transcription.configure({ enabled: true });
    await expect(transcription.transcriptionWorker().drain()).resolves.toBe(1);

    await expect(findMeetingFileRow(suite.prisma(), file.id)).resolves.toMatchObject({
      transcription_status: TRANSCRIBED,
      transcription_attempts: 1,
    });
  });

  it('queues a retry made while it is off, to wait for it like any other queued recording', async () => {
    const { host, meetingId } = await setUp();
    const file = await transcription.uploadReady(host.token, meetingId, fixture('sample.mp3'));
    transcriber.reply = () => UNDECODABLE_REPLY;
    await expect(transcription.transcriptionWorker().drain()).resolves.toBe(1);
    await expect(findMeetingFileRow(suite.prisma(), file.id)).resolves.toMatchObject({
      transcription_status: FAILED,
    });
    transcriber.reply = () => ({ kind: 'text', text: TRANSCRIPT });
    transcription.configure({ enabled: false });

    // The route does not ask about the setting: a retry is a stored status changing, and the
    // setting only decides whether anything is claimed.
    await suite
      .post(meetingFileTranscriptionRetryUrl(meetingId, file.id), {})
      .set('Authorization', `Bearer ${host.token}`)
      .expect(200);

    await expect(transcription.transcriptionWorker().drain()).resolves.toBe(0);
    await expect(findMeetingFileRow(suite.prisma(), file.id)).resolves.toMatchObject({
      status: 'ready',
      transcription_status: QUEUED,
      transcription_attempts: 0,
      transcription_failure_reason: null,
    });

    transcription.configure({ enabled: true });
    await expect(transcription.transcriptionWorker().drain()).resolves.toBe(1);

    await expect(findMeetingFileRow(suite.prisma(), file.id)).resolves.toMatchObject({
      transcription_status: TRANSCRIBED,
      transcription_attempts: 1,
    });
  });

  it('keeps reporting a finished transcript and a failure after it is switched off', async () => {
    const { host, meetingId } = await setUp();
    const noise = undecodableMp3();
    const good = await transcription.uploadReady(host.token, meetingId, fixture('sample.mp3'));
    const bad = await transcription.uploadReady(host.token, meetingId, noise, 'noise.mp3');
    transcriber.reply = ({ bytes }) =>
      bytes === noise.length ? UNDECODABLE_REPLY : { kind: 'text', text: TRANSCRIPT };
    await expect(transcription.transcriptionWorker().drain()).resolves.toBe(2);

    transcription.configure({ enabled: false });

    const listed = await transcription.list(host.token, meetingId);
    expect(listed.find(({ id }) => id === good.id)).toMatchObject({
      transcriptionStatus: 'transcribed',
      transcriptPath: `/meetings/${meetingId}/files/${good.id}/transcript`,
    });
    expect(listed.find(({ id }) => id === bad.id)).toMatchObject({
      transcriptionStatus: 'failed',
      transcriptionFailureReason: TRANSCRIPTION_FAILED_MESSAGE,
    });
    const transcript = await suite
      .get(meetingFileTranscriptUrl(meetingId, good.id))
      .set('Authorization', `Bearer ${host.token}`)
      .expect(200);
    expect(transcript.text).toBe(TRANSCRIPT);
  });
});
