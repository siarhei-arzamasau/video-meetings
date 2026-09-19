import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { MeetingFile } from '@repo/shared';

import { useApiSuite } from './utils/api-suite';
import {
  EMAIL,
  MEETING_FILE_WORKER_TOKEN,
  OTHER_EMAIL,
  THIRD_EMAIL,
  meetingFileRetryUrl,
  meetingFileUrl,
  meetingFilesDir,
  meetingFilesUrl,
} from './utils/fixtures';
import { messageOf } from './utils/http';
import { findMeetingFileRow } from './utils/meeting-files-table';
import { createMeeting, registerUser } from './utils/meeting-files-suite';

const FIXTURES = path.join(__dirname, 'fixtures');
const fixture = (name: string): string => path.join(FIXTURES, name);

/** The one handle the spec needs, reached by token, as in the worker spec. */
interface WorkerHandle {
  drain(): Promise<number>;
}

const sha256 = (file: string): string =>
  createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const objectPath = (meetingId: string, fileId: string): string =>
  path.join(meetingFilesDir(), meetingId, fileId);

describe('POST /api/meetings/:id/files/:fileId/retry', () => {
  const suite = useApiSuite();

  const worker = (): WorkerHandle => suite.app().get<WorkerHandle>(MEETING_FILE_WORKER_TOKEN);

  const upload = async (token: string, meetingId: string): Promise<MeetingFile> => {
    const response = await suite
      .postFile(meetingFilesUrl(meetingId), token, fixture('sample.png'))
      .expect(201);

    return response.body as MeetingFile;
  };

  const retry = (token: string, meetingId: string, fileId: string) =>
    suite.post(meetingFileRetryUrl(meetingId, fileId), {}).set('Authorization', `Bearer ${token}`);

  /** Uploads a PNG, breaks the object, and drains: the shortest route to a `failed` row. */
  const uploadAndFail = async (
    token: string,
    meetingId: string,
  ): Promise<{ file: MeetingFile; whole: Buffer }> => {
    const file = await upload(token, meetingId);
    const whole = fs.readFileSync(objectPath(meetingId, file.id));

    fs.truncateSync(objectPath(meetingId, file.id), 100);
    await expect(worker().drain()).resolves.toBe(1);
    await expect(findMeetingFileRow(suite.prisma(), file.id)).resolves.toMatchObject({
      status: 'failed',
      failure_reason: 'The stored file is incomplete',
    });

    return { file, whole };
  };

  it('sends the uploader’s failed file back through the pipeline, twice over', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const { file, whole } = await uploadAndFail(host.token, meeting.id);

    const response = await retry(host.token, meeting.id, file.id).expect(200);

    expect(response.body).toMatchObject({ id: file.id, status: 'uploaded' });
    // A retried row carries neither the old reason nor the old processing timestamp.
    expect(response.body).not.toHaveProperty('failureReason');
    expect(response.body).not.toHaveProperty('processedAt');
    await expect(findMeetingFileRow(suite.prisma(), file.id)).resolves.toMatchObject({
      status: 'uploaded',
      // Zero, not four: a retry is a fresh chance against the worker's cap, not a fourth
      // attempt at it.
      attempts: 0,
      failure_reason: null,
      processed_at: null,
      leased_until: null,
    });

    // The object is still truncated, so the file really goes back through verify and fails
    // there again. That is what proves the retry re-ran the pipeline rather than the status.
    await expect(worker().drain()).resolves.toBe(1);
    await expect(findMeetingFileRow(suite.prisma(), file.id)).resolves.toMatchObject({
      status: 'failed',
      failure_reason: 'The stored file is incomplete',
      attempts: 1,
    });

    fs.writeFileSync(objectPath(meeting.id, file.id), whole);
    await retry(host.token, meeting.id, file.id).expect(200);
    await expect(worker().drain()).resolves.toBe(1);

    await expect(findMeetingFileRow(suite.prisma(), file.id)).resolves.toMatchObject({
      status: 'ready',
      checksum: sha256(fixture('sample.png')),
      failure_reason: null,
      attempts: 1,
    });
  });

  it('lets the host retry a participant’s file', async () => {
    const host = await registerUser(suite, EMAIL);
    const participant = await registerUser(suite, OTHER_EMAIL);
    const meeting = await createMeeting(suite, host, [participant.id]);
    const { file } = await uploadAndFail(participant.token, meeting.id);

    await retry(host.token, meeting.id, file.id).expect(200);

    await expect(findMeetingFileRow(suite.prisma(), file.id)).resolves.toMatchObject({
      status: 'uploaded',
    });
  });

  it('answers 404 File not found to another participant, leaving the row alone', async () => {
    const host = await registerUser(suite, EMAIL);
    const uploader = await registerUser(suite, OTHER_EMAIL);
    const other = await registerUser(suite, THIRD_EMAIL);
    const meeting = await createMeeting(suite, host, [uploader.id, other.id]);
    const { file } = await uploadAndFail(uploader.token, meeting.id);
    const before = await findMeetingFileRow(suite.prisma(), file.id);

    const response = await retry(other.token, meeting.id, file.id).expect(404);

    expect(messageOf(response)).toBe('File not found');
    await expect(findMeetingFileRow(suite.prisma(), file.id)).resolves.toEqual(before);
  });

  it('answers 409 for a file that is not failed', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const file = await upload(host.token, meeting.id);

    await expect(worker().drain()).resolves.toBe(1);
    await expect(findMeetingFileRow(suite.prisma(), file.id)).resolves.toMatchObject({
      status: 'ready',
    });

    const response = await retry(host.token, meeting.id, file.id).expect(409);

    expect(messageOf(response)).toBe('Only a failed file can be retried');
    await expect(findMeetingFileRow(suite.prisma(), file.id)).resolves.toMatchObject({
      status: 'ready',
    });
  });

  it('answers 404 for a deleted file, which no longer exists for any caller', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const { file } = await uploadAndFail(host.token, meeting.id);

    await suite
      .delete(meetingFileUrl(meeting.id, file.id))
      .set('Authorization', `Bearer ${host.token}`)
      .expect(204);

    const response = await retry(host.token, meeting.id, file.id).expect(404);

    expect(messageOf(response)).toBe('File not found');
    await expect(findMeetingFileRow(suite.prisma(), file.id)).resolves.toMatchObject({
      status: 'deleted',
    });
  });

  it('answers 404 Meeting not found to a stranger', async () => {
    const host = await registerUser(suite, EMAIL);
    const stranger = await registerUser(suite, OTHER_EMAIL);
    const meeting = await createMeeting(suite, host);
    const { file } = await uploadAndFail(host.token, meeting.id);

    const response = await retry(stranger.token, meeting.id, file.id).expect(404);

    expect(messageOf(response)).toBe('Meeting not found');
    await expect(findMeetingFileRow(suite.prisma(), file.id)).resolves.toMatchObject({
      status: 'failed',
    });
  });

  it('rejects an anonymous caller and a malformed file id before any lookup', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const { file } = await uploadAndFail(host.token, meeting.id);

    await suite.post(meetingFileRetryUrl(meeting.id, file.id), {}).expect(401);
    await retry(host.token, meeting.id, 'not-a-uuid').expect(400);
  });
});
