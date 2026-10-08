import fs from 'node:fs';

import type { MeetingFile } from '@repo/shared';

import { useApiSuite } from './utils/api-suite';
import {
  EMAIL,
  OTHER_EMAIL,
  THIRD_EMAIL,
  meetingFileContentUrl,
  meetingFileEventsUrl,
  meetingFileTranscriptUrl,
} from './utils/fixtures';
import { messageOf } from './utils/http';
import { QUEUED, TRANSCRIBED, TRANSCRIBING } from './utils/meeting-file-transcription-table';
import { findMeetingFileRow } from './utils/meeting-files-table';
import { createMeeting, registerUser } from './utils/meeting-files-suite';
import { openSse } from './utils/sse';
import type { SseClient } from './utils/sse';
import {
  DEFAULT_MODEL,
  TRANSCRIPT,
  fixture,
  fixtureSize,
  transcriptPath,
  useTranscriptionSuite,
} from './utils/transcription-suite';

/** The `MeetingFile` the next `file` event carried, skipping any heartbeat before it. */
const fileOf = async (client: SseClient): Promise<MeetingFile> =>
  JSON.parse((await client.nextOf('file')).data) as MeetingFile;

describe('transcription as a status of its own', () => {
  const suite = useApiSuite();
  const transcription = useTranscriptionSuite(suite);
  const { transcriber } = transcription;
  const open: SseClient[] = [];

  const watch = async (token: string, meetingId: string): Promise<SseClient> => {
    const client = await openSse(suite, meetingFileEventsUrl(meetingId), token);
    open.push(client);

    return client;
  };

  const get = (url: string, token: string) =>
    suite.get(url).set('Authorization', `Bearer ${token}`);

  afterEach(() => {
    for (const client of open.splice(0)) {
      client.close();
    }
  });

  it('makes an MP3 ready and downloadable while its transcription is still queued', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const uploaded = await transcription.upload(host.token, meeting.id, fixture('sample.mp3'));

    // Nothing is promised about a transcript before the file's own checks have passed.
    expect(uploaded).not.toHaveProperty('transcriptionStatus');
    await expect(transcription.fileWorker().drain()).resolves.toBe(1);

    await expect(findMeetingFileRow(suite.prisma(), uploaded.id)).resolves.toMatchObject({
      status: 'ready',
      leased_until: null,
      transcription_status: QUEUED,
      transcription_attempts: 0,
      transcription_leased_until: null,
      transcript_key: null,
    });
    // Ready means ready: the file's worker never spoke to the transcriber.
    expect(transcriber.calls).toEqual([]);
    await expect(transcription.list(host.token, meeting.id)).resolves.toEqual([
      {
        ...uploaded,
        status: 'ready',
        processedAt: expect.any(String),
        transcriptionStatus: 'queued',
      },
    ]);

    const download = await get(meetingFileContentUrl(meeting.id, uploaded.id), host.token)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(download.body).toEqual(fs.readFileSync(fixture('sample.mp3')));

    const transcript = await get(meetingFileTranscriptUrl(meeting.id, uploaded.id), host.token);
    expect(transcript.status).toBe(404);
    expect(messageOf(transcript)).toBe('Transcript not found');
  });

  it('carries queued, transcribing and transcribed on the stream, in that order', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const client = await watch(host.token, meeting.id);
    const uploaded = await transcription.uploadReady(host.token, meeting.id, fixture('sample.mp3'));

    await expect(fileOf(client)).resolves.toEqual(uploaded);
    const processing = await fileOf(client);
    expect(processing).toMatchObject({ status: 'processing' });
    expect(processing).not.toHaveProperty('transcriptionStatus');
    // One event for one write: the file is ready and its transcription queued together.
    await expect(fileOf(client)).resolves.toMatchObject({
      status: 'ready',
      transcriptionStatus: 'queued',
    });

    transcriber.reply = () => ({ kind: 'hold' });
    const drained = transcription.transcriptionWorker().drain();
    await transcriber.arrived(1);

    const transcribing = await fileOf(client);
    expect(transcribing).toMatchObject({ status: 'ready', transcriptionStatus: 'transcribing' });
    expect(transcribing).not.toHaveProperty('transcriptPath');
    await expect(findMeetingFileRow(suite.prisma(), uploaded.id)).resolves.toMatchObject({
      status: 'ready',
      transcription_status: TRANSCRIBING,
      transcription_attempts: 1,
      transcription_leased_until: expect.any(String),
    });
    // Still downloadable with the transcription in flight.
    await get(meetingFileContentUrl(meeting.id, uploaded.id), host.token).expect(200);

    transcriber.release(TRANSCRIPT);
    await expect(drained).resolves.toBe(1);

    await expect(fileOf(client)).resolves.toMatchObject({
      id: uploaded.id,
      status: 'ready',
      transcriptionStatus: 'transcribed',
      transcriptPath: `/meetings/${meeting.id}/files/${uploaded.id}/transcript`,
    });
  });

  it('stores the transcript and serves it from its own route', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const file = await transcription.uploadReady(host.token, meeting.id, fixture('sample.mp3'));

    await expect(transcription.transcriptionWorker().drain()).resolves.toBe(1);

    await expect(findMeetingFileRow(suite.prisma(), file.id)).resolves.toMatchObject({
      status: 'ready',
      transcription_status: TRANSCRIBED,
      transcription_failure_reason: null,
      transcription_attempts: 1,
      transcription_leased_until: null,
      transcript_key: `${meeting.id}/${file.id}.transcript.txt`,
    });
    // The whole object reached the endpoint, under the adapter's filename and the default model.
    expect(transcriber.calls).toEqual([
      { model: DEFAULT_MODEL, filename: 'recording.mp3', bytes: fixtureSize('sample.mp3') },
    ]);
    expect(fs.readFileSync(transcriptPath(meeting.id, file.id), 'utf8')).toBe(TRANSCRIPT);

    const response = await get(meetingFileTranscriptUrl(meeting.id, file.id), host.token);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['content-disposition']).toContain('inline');
    expect(response.text).toBe(TRANSCRIPT);
  });

  it('gives a PDF and a PNG no transcription status at all', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const pdf = await transcription.upload(host.token, meeting.id, fixture('sample.pdf'));
    const png = await transcription.upload(host.token, meeting.id, fixture('sample.png'));

    await expect(transcription.fileWorker().drain()).resolves.toBe(2);
    await expect(transcription.transcriptionWorker().drain()).resolves.toBe(0);

    const rows = await Promise.all(
      [pdf, png].map((file) => findMeetingFileRow(suite.prisma(), file.id)),
    );
    for (const row of rows) {
      expect(row).toMatchObject({
        status: 'ready',
        transcription_status: null,
        transcription_attempts: 0,
        transcript_key: null,
      });
    }
    const listed = await transcription.list(host.token, meeting.id);
    expect(listed).toHaveLength(2);
    for (const file of listed) {
      expect(file).not.toHaveProperty('transcriptionStatus');
      expect(file).not.toHaveProperty('transcriptPath');
    }
    expect(transcriber.calls).toEqual([]);
  });

  it('shows a participant the same list and transcript, and a stranger a 404', async () => {
    const host = await registerUser(suite, EMAIL);
    const guest = await registerUser(suite, OTHER_EMAIL);
    const stranger = await registerUser(suite, THIRD_EMAIL);
    const meeting = await createMeeting(suite, host, [guest.id]);
    const file = await transcription.uploadReady(host.token, meeting.id, fixture('sample.mp3'));
    await transcription.transcriptionWorker().drain();

    const asHost = await transcription.list(host.token, meeting.id);
    expect(asHost).toEqual([expect.objectContaining({ transcriptionStatus: 'transcribed' })]);
    await expect(transcription.list(guest.token, meeting.id)).resolves.toEqual(asHost);

    const url = meetingFileTranscriptUrl(meeting.id, file.id);
    const asGuest = await get(url, guest.token);
    expect(asGuest.status).toBe(200);
    expect(asGuest.text).toBe(TRANSCRIPT);

    const outside = await get(url, stranger.token);
    expect(outside.status).toBe(404);
    expect(messageOf(outside)).toBe('Meeting not found');
    await suite.get(url).expect(401);
  });
});
