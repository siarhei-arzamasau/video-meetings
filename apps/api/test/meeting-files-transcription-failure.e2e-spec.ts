import fs from 'node:fs';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

import { ConfigService } from '@nestjs/config';
import type { MeetingFile } from '@repo/shared';

import { useApiSuite } from './utils/api-suite';
import {
  EMAIL,
  meetingFileContentUrl,
  meetingFileEventsUrl,
  meetingFileTranscriptUrl,
  meetingFileTranscriptionRetryUrl,
} from './utils/fixtures';
import type { TranscriberReply } from './utils/fake-transcriber';
import { FAILED, TRANSCRIBED } from './utils/meeting-file-transcription-table';
import { findMeetingFileRow } from './utils/meeting-files-table';
import { createMeeting, registerUser } from './utils/meeting-files-suite';
import type { RegisteredUser } from './utils/meeting-files-suite';
import { openSse } from './utils/sse';
import type { SseClient } from './utils/sse';
import {
  ENDPOINT_MARKER,
  TRANSCRIPT,
  TRANSCRIPTION_FAILED_MESSAGE,
  UNDECODABLE_REPLY,
  fixture,
  fixtureSize,
  transcriptPath,
  transcriptionTimeLimitMessage,
  undecodableMp3,
  useTranscriptionSuite,
} from './utils/transcription-suite';

/** The endpoint falling over, as opposed to refusing one recording: a 500 in its own words. */
const ENDPOINT_ERROR: TranscriberReply = {
  kind: 'error',
  status: 500,
  body: JSON.stringify({ detail: `${ENDPOINT_MARKER}: CUDA out of memory` }),
};

/** A loopback port nothing is listening on: bound, read, and released. */
const unusedPort = async (): Promise<number> => {
  const server = net.createServer();

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });

  return port;
};

describe('a transcription that fails', () => {
  const suite = useApiSuite();
  const transcription = useTranscriptionSuite(suite);
  const { transcriber } = transcription;
  const open: SseClient[] = [];

  const get = (url: string, token: string) =>
    suite.get(url).set('Authorization', `Bearer ${token}`);

  afterEach(() => {
    for (const client of open.splice(0)) {
      client.close();
    }
  });

  const setUp = async (): Promise<{ host: RegisteredUser; meetingId: string }> => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);

    return { host, meetingId: meeting.id };
  };

  /**
   * What every failure has to leave behind: a file that is still `ready` and still
   * downloadable, a failed transcription with `reason`, no transcript on disk or over HTTP,
   * and nothing of the endpoint's own words anywhere a client can read.
   */
  const expectFailedButReady = async (
    host: RegisteredUser,
    file: MeetingFile,
    reason: string,
  ): Promise<void> => {
    const row = await findMeetingFileRow(suite.prisma(), file.id);
    expect(row).toMatchObject({
      status: 'ready',
      failure_reason: null,
      transcription_status: FAILED,
      transcription_failure_reason: reason,
      transcription_leased_until: null,
      transcript_key: null,
    });
    expect(fs.existsSync(transcriptPath(file.meetingId, file.id))).toBe(false);

    const listed = await transcription.list(host.token, file.meetingId);
    expect(listed.find(({ id }) => id === file.id)).toMatchObject({
      status: 'ready',
      transcriptionStatus: 'failed',
      transcriptionFailureReason: reason,
    });
    expect(JSON.stringify([row, listed])).not.toContain(ENDPOINT_MARKER);

    await get(meetingFileContentUrl(file.meetingId, file.id), host.token).expect(200);
    await get(meetingFileTranscriptUrl(file.meetingId, file.id), host.token).expect(404);
  };

  it('ends Failed with fixed copy when the endpoint answers an error, and says so on the stream', async () => {
    const { host, meetingId } = await setUp();
    const file = await transcription.uploadReady(host.token, meetingId, fixture('sample.mp3'));
    const client = await openSse(suite, meetingFileEventsUrl(meetingId), host.token);
    open.push(client);
    transcriber.reply = () => ENDPOINT_ERROR;

    await expect(transcription.transcriptionWorker().drain()).resolves.toBe(1);

    const transcribing = (await client.nextOf('file')).data;
    const failed = (await client.nextOf('file')).data;
    expect(JSON.parse(transcribing)).toMatchObject({ transcriptionStatus: 'transcribing' });
    expect(JSON.parse(failed)).toMatchObject({
      id: file.id,
      status: 'ready',
      transcriptionStatus: 'failed',
      transcriptionFailureReason: TRANSCRIPTION_FAILED_MESSAGE,
    });
    expect(failed).not.toContain(ENDPOINT_MARKER);
    await expectFailedButReady(host, file, TRANSCRIPTION_FAILED_MESSAGE);
    // One request and no more: a failure is not retried behind the user's back.
    expect(transcriber.calls).toHaveLength(1);
  });

  it('ends Failed when nothing is listening at the endpoint, with the file still downloadable', async () => {
    const { host, meetingId } = await setUp();
    const file = await transcription.uploadReady(host.token, meetingId, fixture('sample.mp3'));
    suite
      .app()
      .get(ConfigService)
      .set(
        'TRANSCRIPTION_API_URL',
        `http://127.0.0.1:${String(await unusedPort())}/v1/audio/transcriptions`,
      );

    await expect(transcription.transcriptionWorker().drain()).resolves.toBe(1);

    await expectFailedButReady(host, file, TRANSCRIPTION_FAILED_MESSAGE);
  });

  it('ends Failed for a recording that passes the type check but cannot be decoded', async () => {
    const { host, meetingId } = await setUp();
    const bytes = undecodableMp3();
    const file = await transcription.uploadReady(host.token, meetingId, bytes, 'noise.mp3');
    // The endpoint is what finds out, and answers as the Whisper service does to these bytes.
    transcriber.reply = ({ bytes: received }) =>
      received === bytes.length ? UNDECODABLE_REPLY : { kind: 'text', text: TRANSCRIPT };

    expect(file).toMatchObject({ contentType: 'audio/mpeg' });
    await expect(transcription.transcriptionWorker().drain()).resolves.toBe(1);

    await expectFailedButReady(host, file, TRANSCRIPTION_FAILED_MESSAGE);
  });

  it('ends Failed naming the limit when a transcription outruns it, and hangs up on the endpoint', async () => {
    const { host, meetingId } = await setUp();
    const file = await transcription.uploadReady(host.token, meetingId, fixture('sample.mp3'));
    transcription.configure({ timeLimitSeconds: 1 });
    transcriber.reply = () => ({ kind: 'hold' });

    await expect(transcription.transcriptionWorker().drain()).resolves.toBe(1);

    await expectFailedButReady(host, file, transcriptionTimeLimitMessage('1-second'));
    expect(transcriber.hangUps).toBe(1);

    // The one failure a retry cannot help, so it is refused and the row stays as it was.
    await suite
      .post(meetingFileTranscriptionRetryUrl(meetingId, file.id), {})
      .set('Authorization', `Bearer ${host.token}`)
      .expect(409);
    await expectFailedButReady(host, file, transcriptionTimeLimitMessage('1-second'));
  });

  it('fails one of two recordings and leaves the other untouched', async () => {
    const { host, meetingId } = await setUp();
    const good = await transcription.uploadReady(host.token, meetingId, fixture('sample.mp3'));
    const bad = await transcription.uploadReady(host.token, meetingId, undecodableMp3(), 'bad.mp3');
    transcriber.reply = ({ bytes }) =>
      bytes === fixtureSize('sample.mp3') ? { kind: 'text', text: TRANSCRIPT } : UNDECODABLE_REPLY;

    await expect(transcription.transcriptionWorker().drain()).resolves.toBe(2);

    await expectFailedButReady(host, bad, TRANSCRIPTION_FAILED_MESSAGE);
    await expect(findMeetingFileRow(suite.prisma(), good.id)).resolves.toMatchObject({
      status: 'ready',
      transcription_status: TRANSCRIBED,
      transcription_failure_reason: null,
    });
    const transcript = await get(meetingFileTranscriptUrl(meetingId, good.id), host.token);
    expect(transcript.text).toBe(TRANSCRIPT);
  });
});
