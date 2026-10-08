import type { MeetingFile, MeetingFileUpload } from '@repo/shared';

import { useApiSuite } from './utils/api-suite';
import {
  EMAIL,
  MEETING_FILE_CHUNK_SIZE_BYTES,
  meetingFileChunkUrl,
  meetingFileCompleteUrl,
  meetingFileContentUrl,
  meetingFileEventsUrl,
  meetingFileTranscriptUrl,
  meetingFileUploadsUrl,
} from './utils/fixtures';
import { QUEUED } from './utils/meeting-file-transcription-table';
import { findMeetingFileRow } from './utils/meeting-files-table';
import { createMeeting, putBytes, registerUser } from './utils/meeting-files-suite';
import { openSse } from './utils/sse';
import type { SseClient } from './utils/sse';
import { DEFAULT_MODEL, TRANSCRIPT, useTranscriptionSuite } from './utils/transcription-suite';

/**
 * An MP4 as far as the type check is concerned — an `ftyp` box with a generic brand — padded
 * past one chunk, so the session it is uploaded through really has two.
 */
const twoChunkMp4 = (): Buffer => {
  const ftyp = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftypisom', 'latin1'),
    Buffer.from([0x00, 0x00, 0x02, 0x00]),
    Buffer.from('isomiso2', 'latin1'),
  ]);

  return Buffer.concat([ftyp, Buffer.alloc(MEETING_FILE_CHUNK_SIZE_BYTES + 1024 - ftyp.length)]);
};

const authorised = (token: string): { Authorization: string } => ({
  Authorization: `Bearer ${token}`,
});

/** The statuses the next `file` event carried: the file's own, and its transcription's. */
const edgeOf = async (client: SseClient): Promise<[string, string | undefined]> => {
  const file = JSON.parse((await client.nextOf('file')).data) as MeetingFile;

  return [file.status, file.transcriptionStatus];
};

/**
 * The chunked path ends in the same upload command as a single request, so a recording that
 * arrived in chunks has to be queued and transcribed exactly as one that did not — which only
 * a recording that really went through a session can show.
 */
describe('transcription of a recording uploaded in chunks', () => {
  const suite = useApiSuite();
  const transcription = useTranscriptionSuite(suite);
  const { transcriber } = transcription;
  const open: SseClient[] = [];

  afterEach(() => {
    for (const client of open.splice(0)) {
      client.close();
    }
  });

  /** Opens a session, sends every chunk in order, and completes it. */
  const uploadInChunks = async (
    token: string,
    meetingId: string,
    bytes: Buffer,
  ): Promise<MeetingFile> => {
    const session = await suite
      .post(meetingFileUploadsUrl(meetingId), { name: 'standup.mp4', size: bytes.length })
      .set(authorised(token))
      .expect(201);
    const { id, chunkSize, chunkCount } = session.body as MeetingFileUpload;

    // Sequentially, as a client would — a reduce, as the chunked upload spec sends them.
    await Array.from({ length: chunkCount }, (_, index) => index).reduce(
      async (previous, index) => {
        await previous;
        await putBytes(
          suite,
          meetingFileChunkUrl(meetingId, id, index),
          token,
          bytes.subarray(index * chunkSize, (index + 1) * chunkSize),
        ).expect(204);
      },
      Promise.resolve(),
    );

    const completed = await suite
      .post(meetingFileCompleteUrl(meetingId, id), {})
      .set(authorised(token))
      .expect(201);

    return completed.body as MeetingFile;
  };

  it('is ready and downloadable while queued, then transcribed, with each edge on the stream', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const bytes = twoChunkMp4();
    const client = await openSse(suite, meetingFileEventsUrl(meeting.id), host.token);
    open.push(client);
    const file = await uploadInChunks(host.token, meeting.id, bytes);

    expect(file).toMatchObject({ contentType: 'video/mp4', size: bytes.length });
    await expect(transcription.fileWorker().drain()).resolves.toBe(1);
    await expect(edgeOf(client)).resolves.toEqual(['uploaded', undefined]);
    await expect(edgeOf(client)).resolves.toEqual(['processing', undefined]);
    await expect(edgeOf(client)).resolves.toEqual(['ready', 'queued']);

    await expect(findMeetingFileRow(suite.prisma(), file.id)).resolves.toMatchObject({
      status: 'ready',
      transcription_status: QUEUED,
    });
    await expect(transcription.list(host.token, meeting.id)).resolves.toEqual([
      expect.objectContaining({ id: file.id, status: 'ready', transcriptionStatus: 'queued' }),
    ]);
    await suite
      .get(meetingFileContentUrl(meeting.id, file.id))
      .set(authorised(host.token))
      .expect(200);
    expect(transcriber.calls).toEqual([]);

    await expect(transcription.transcriptionWorker().drain()).resolves.toBe(1);
    await expect(edgeOf(client)).resolves.toEqual(['ready', 'transcribing']);
    await expect(edgeOf(client)).resolves.toEqual(['ready', 'transcribed']);

    // Every assembled byte reached the endpoint, streamed under the name its type implies.
    expect(transcriber.calls).toEqual([
      { model: DEFAULT_MODEL, filename: 'recording.mp4', bytes: bytes.length },
    ]);
    await expect(transcription.list(host.token, meeting.id)).resolves.toEqual([
      expect.objectContaining({ id: file.id, status: 'ready', transcriptionStatus: 'transcribed' }),
    ]);
    const transcript = await suite
      .get(meetingFileTranscriptUrl(meeting.id, file.id))
      .set(authorised(host.token))
      .expect(200);
    expect(transcript.text).toBe(TRANSCRIPT);
  }, 120_000);
});
