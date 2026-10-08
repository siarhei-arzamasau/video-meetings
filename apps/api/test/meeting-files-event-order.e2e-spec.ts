import fs from 'node:fs';

import { EventBus } from '@nestjs/cqrs';
import type { MeetingFile } from '@repo/shared';

import { MeetingFileChangedEvent } from '../src/modules/meeting-files/events/meeting-file-changed.event';
import { holdWrite } from '../src/modules/meeting-files/services/held-write.fixture';
import { MeetingFileHandOvers } from '../src/modules/meeting-files/services/meeting-file-hand-overs';
import { useApiSuite } from './utils/api-suite';
import {
  EMAIL,
  meetingFileEventsUrl,
  meetingFileRetryUrl,
  meetingFileTranscriptionRetryUrl,
  meetingFileUrl,
} from './utils/fixtures';
import { FAILED, TRANSCRIBING } from './utils/meeting-file-transcription-table';
import { findMeetingFileRow } from './utils/meeting-files-table';
import type { MeetingFileRow } from './utils/meeting-files-table';
import { createMeeting, registerUser } from './utils/meeting-files-suite';
import { openSse } from './utils/sse';
import type { SseClient } from './utils/sse';
import { fixture, objectPath, useTranscriptionSuite } from './utils/transcription-suite';

/** Long enough for an announcement that was going to be made to have reached the stream. */
const SILENCE_MS = 300;
const CLAIM_WAIT_MS = 2_000;

/** The `MeetingFile` the next `file` event carried, skipping any heartbeat before it. */
const fileOf = async (client: SseClient): Promise<MeetingFile> =>
  JSON.parse((await client.nextOf('file')).data) as MeetingFile;

/**
 * The order two publishers announce one row in, through the application as it is wired: the
 * module's one `MeetingFileHandOvers`, both workers, the handlers, and the stream a page reads.
 *
 * The inversion itself cannot be asked for — it is Node resuming a claim before the write
 * that made the row claimable, a few runs in a thousand. What can be is the moment it
 * happens in: a hand-over held open in the registry while the worker's claim comes back,
 * and a worker's announcement put on the bus after the delete it should have preceded.
 */
describe('The order two publishers’ events reach a stream in', () => {
  const suite = useApiSuite();
  const transcription = useTranscriptionSuite(suite);
  const open: SseClient[] = [];

  afterEach(() => {
    jest.restoreAllMocks();

    for (const client of open.splice(0)) {
      client.close();
    }
  });

  const handOvers = (): MeetingFileHandOvers => suite.app().get(MeetingFileHandOvers);
  const rowOf = (file: MeetingFile): Promise<MeetingFileRow> =>
    findMeetingFileRow(suite.prisma(), file.id);

  const watch = async (meetingId: string, token: string): Promise<SseClient> => {
    const client = await openSse(suite, meetingFileEventsUrl(meetingId), token);
    open.push(client);

    return client;
  };

  /** A hand-over of the file whose announcement is still on its way, until `finish`. */
  const holdHandOver = (file: MeetingFile): { finish(): void } => {
    const announcement = holdWrite();

    void handOvers().run(file.id, () => announcement.answered);

    return { finish: () => announcement.answer() };
  };

  /** Waits for the claim to have committed, which is when its announcement would be made. */
  const untilClaimed = async (
    file: MeetingFile,
    claimed: (row: MeetingFileRow) => boolean,
    deadline = Date.now() + CLAIM_WAIT_MS,
  ): Promise<void> => {
    if (claimed(await rowOf(file))) {
      return;
    }

    if (Date.now() > deadline) {
      throw new Error('The worker never claimed the row.');
    }

    await new Promise((resolve) => setTimeout(resolve, 10));

    return untilClaimed(file, claimed, deadline);
  };

  const setUp = async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);

    return { host, meeting };
  };

  it('keeps "transcribing" off the stream until the write that queued the recording is announced', async () => {
    const { host, meeting } = await setUp();
    const file = await transcription.uploadReady(host.token, meeting.id, fixture('sample.mp3'));
    const client = await watch(meeting.id, host.token);
    const queueing = holdHandOver(file);

    const drained = transcription.transcriptionWorker().drain();
    await untilClaimed(file, (row) => row.transcription_status === TRANSCRIBING);

    // The claim is committed and the worker has it. Announced now, "transcribing" would reach
    // the page ahead of the "queued" still on its way, and "queued" is what would stay.
    await expect(client.nextOf('file', SILENCE_MS)).rejects.toThrow();
    expect(transcription.transcriber.calls).toHaveLength(0);

    queueing.finish();

    await expect(fileOf(client)).resolves.toMatchObject({ transcriptionStatus: 'transcribing' });
    await expect(fileOf(client)).resolves.toMatchObject({ transcriptionStatus: 'transcribed' });
    await expect(drained).resolves.toBe(1);
  });

  it('keeps "processing" off the stream until the upload that created the file is announced', async () => {
    const { host, meeting } = await setUp();
    const file = await transcription.upload(host.token, meeting.id, fixture('sample.png'));
    const client = await watch(meeting.id, host.token);
    const uploading = holdHandOver(file);

    const drained = transcription.fileWorker().drain();
    await untilClaimed(file, (row) => row.status === 'processing');

    // Otherwise "uploaded" could land after "processing", or after "ready" — and a file that
    // is done would sit on Processing.
    await expect(client.nextOf('file', SILENCE_MS)).rejects.toThrow();

    uploading.finish();

    await expect(fileOf(client)).resolves.toMatchObject({ status: 'processing' });
    await expect(fileOf(client)).resolves.toMatchObject({ status: 'ready' });
    await expect(drained).resolves.toBe(1);
  });

  it('runs every write that hands a row to a worker through that one registry', async () => {
    const { host, meeting } = await setUp();
    const run = jest.spyOn(handOvers(), 'run');
    const handedOver = (): string[] => run.mock.calls.map(([fileId]) => fileId);
    const post = (url: string) =>
      suite.post(url, {}).set('Authorization', `Bearer ${host.token}`).expect(200);

    // The upload, then the `ready` that queues the recording.
    const recording = await transcription.upload(host.token, meeting.id, fixture('sample.mp3'));
    expect(handedOver()).toEqual([recording.id]);
    await transcription.fileWorker().drain();
    expect(handedOver()).toEqual([recording.id, recording.id]);

    // The transcription's retry.
    transcription.transcriber.reply = () => ({ kind: 'error', status: 503, body: 'Unavailable' });
    await transcription.transcriptionWorker().drain();
    await expect(rowOf(recording)).resolves.toMatchObject({ transcription_status: FAILED });
    await post(meetingFileTranscriptionRetryUrl(meeting.id, recording.id));
    expect(handedOver()).toEqual([recording.id, recording.id, recording.id]);

    // The file's retry: an image whose object was cut short fails its checks.
    const image = await transcription.upload(host.token, meeting.id, fixture('sample.png'));
    fs.truncateSync(objectPath(meeting.id, image.id), 100);
    await transcription.fileWorker().drain();
    await expect(rowOf(image)).resolves.toMatchObject({ status: 'failed' });
    run.mockClear();
    await post(meetingFileRetryUrl(meeting.id, image.id));
    expect(handedOver()).toEqual([image.id]);
  });

  it('says nothing for a file after its delete, however late a worker’s announcement lands', async () => {
    const { host, meeting } = await setUp();
    const file = await transcription.uploadReady(host.token, meeting.id, fixture('sample.mp3'));
    await transcription.transcriptionWorker().drain();
    const [transcribed] = await transcription.list(host.token, meeting.id);
    const client = await watch(meeting.id, host.token);

    await suite
      .delete(meetingFileUrl(meeting.id, file.id))
      .set('Authorization', `Bearer ${host.token}`)
      .expect(204);
    await expect(fileOf(client)).resolves.toMatchObject({ id: file.id, status: 'deleted' });

    // "Transcribed", as the worker announces it when its write committed just before the
    // delete and Node resumed the delete first. Passed on, a page would put the row back.
    expect(transcribed).toMatchObject({ id: file.id, transcriptionStatus: 'transcribed' });
    suite
      .app()
      .get(EventBus)
      .publish(new MeetingFileChangedEvent(meeting.id, transcribed as MeetingFile));
    await expect(client.nextOf('file', SILENCE_MS)).rejects.toThrow();

    // The purge repeats the delete, and that still goes out.
    await transcription.fileWorker().drain();
    await expect(fileOf(client)).resolves.toMatchObject({ id: file.id, status: 'deleted' });
  });
});
