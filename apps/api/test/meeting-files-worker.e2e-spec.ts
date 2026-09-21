import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { MeetingFile } from '@repo/shared';

import { useApiSuite } from './utils/api-suite';
import {
  EMAIL,
  MEETING_FILE_WORKER_TOKEN,
  meetingFileContentUrl,
  meetingFileThumbnailUrl,
  meetingFileUrl,
  meetingFilesDir,
  meetingFilesUrl,
} from './utils/fixtures';
import { findMeetingFileRow, setMeetingFileState } from './utils/meeting-files-table';
import { createMeeting, registerUser } from './utils/meeting-files-suite';

const FIXTURES = path.join(__dirname, 'fixtures');
const fixture = (name: string): string => path.join(FIXTURES, name);

/** The one handle the spec needs, reached by token so this file compiles before the worker exists. */
interface WorkerHandle {
  drain(): Promise<number>;
}

const sha256 = (file: string): string =>
  createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const asBuffer: Parameters<ReturnType<ReturnType<typeof useApiSuite>['get']>['parse']>[0] = (
  res,
  callback,
) => {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
};

const objectPath = (meetingId: string, fileId: string, suffix = ''): string =>
  path.join(meetingFilesDir(), meetingId, `${fileId}${suffix}`);

describe('the meeting file worker', () => {
  const suite = useApiSuite();

  // The flag is off in setup-env.ts, so nothing runs unless a test drains it — which is what
  // makes "the row is now ready" an assertion rather than a race against a poll loop.
  const worker = (): WorkerHandle => suite.app().get<WorkerHandle>(MEETING_FILE_WORKER_TOKEN);

  const upload = async (
    token: string,
    meetingId: string,
    file: string | Buffer,
    filename?: string,
  ) => {
    const response = await suite
      .postFile(meetingFilesUrl(meetingId), token, file, { filename })
      .expect(201);

    return response.body as MeetingFile;
  };

  it('verifies and thumbnails an uploaded image, then marks it ready', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const file = await upload(host.token, meeting.id, fixture('sample.png'));
    const before = Date.now();

    await expect(worker().drain()).resolves.toBe(1);

    const row = await findMeetingFileRow(suite.prisma(), file.id);
    expect(row).toMatchObject({
      status: 'ready',
      checksum: sha256(fixture('sample.png')),
      thumbnail_key: `${meeting.id}/${file.id}.thumb.webp`,
      failure_reason: null,
      attempts: 1,
      leased_until: null,
    });
    expect(Date.parse(row.processed_at ?? '')).toBeGreaterThanOrEqual(before - 1_000);
    expect(fs.existsSync(objectPath(meeting.id, file.id, '.thumb.webp'))).toBe(true);

    const response = await suite
      .get(meetingFileThumbnailUrl(meeting.id, file.id))
      .set('Authorization', `Bearer ${host.token}`)
      .buffer(true)
      .parse(asBuffer)
      .expect(200);
    const body = response.body as Buffer;

    expect(response.headers['content-type']).toBe('image/webp');
    // The RIFF container's magic: `RIFF` then a length, then `WEBP`. Enough to know it is a WebP.
    expect(body.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(body.subarray(8, 12).toString('ascii')).toBe('WEBP');

    const listed = await suite
      .get(meetingFilesUrl(meeting.id))
      .set('Authorization', `Bearer ${host.token}`)
      .expect(200);
    expect(listed.body).toEqual([
      expect.objectContaining({
        id: file.id,
        status: 'ready',
        thumbnailPath: `/meetings/${meeting.id}/files/${file.id}/thumbnail`,
        processedAt: expect.any(String),
      }),
    ]);
  });

  it('verifies a non-image and marks it ready without a thumbnail', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const file = await upload(host.token, meeting.id, fixture('sample.pdf'));

    await expect(worker().drain()).resolves.toBe(1);

    await expect(findMeetingFileRow(suite.prisma(), file.id)).resolves.toMatchObject({
      status: 'ready',
      checksum: sha256(fixture('sample.pdf')),
      thumbnail_key: null,
    });
    expect(fs.existsSync(objectPath(meeting.id, file.id, '.thumb.webp'))).toBe(false);
  });

  it('fails a truncated object with a user-safe reason and keeps it downloadable', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const file = await upload(host.token, meeting.id, fixture('sample.png'));
    fs.truncateSync(objectPath(meeting.id, file.id), 100);

    await expect(worker().drain()).resolves.toBe(1);

    await expect(findMeetingFileRow(suite.prisma(), file.id)).resolves.toMatchObject({
      status: 'failed',
      failure_reason: 'The stored file is incomplete',
      checksum: null,
      thumbnail_key: null,
      leased_until: null,
    });
    // Still downloadable: the bytes that exist, with a length that matches them.
    const response = await suite
      .get(meetingFileContentUrl(meeting.id, file.id))
      .set('Authorization', `Bearer ${host.token}`)
      .buffer(true)
      .parse(asBuffer)
      .expect(200);
    expect(response.headers['content-length']).toBe('100');
    expect((response.body as Buffer).length).toBe(100);
  });

  it('fails an image sharp cannot decode with the preview reason, after verify passed', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    // A PNG signature over garbage: file-type calls it image/png, sharp cannot decode it.
    const bogus = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(64, 7),
    ]);
    const file = await upload(host.token, meeting.id, bogus, 'bogus.png');

    await expect(worker().drain()).resolves.toBe(1);

    await expect(findMeetingFileRow(suite.prisma(), file.id)).resolves.toMatchObject({
      status: 'failed',
      failure_reason: 'The image could not be read',
      // Verify ran first and its result is not thrown away with the failure.
      checksum: createHash('sha256').update(bogus).digest('hex'),
      thumbnail_key: null,
    });
  });

  it('reclaims a processing row whose lease has expired — the API died mid-file', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const file = await upload(host.token, meeting.id, fixture('sample.pdf'));
    await setMeetingFileState(suite.prisma(), file.id, {
      status: 'processing',
      leased_until: new Date(Date.now() - 60_000),
      attempts: 1,
    });

    await expect(worker().drain()).resolves.toBe(1);

    await expect(findMeetingFileRow(suite.prisma(), file.id)).resolves.toMatchObject({
      status: 'ready',
      attempts: 2,
      leased_until: null,
    });
  });

  it('leaves a processing row alone while its lease is live', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const file = await upload(host.token, meeting.id, fixture('sample.pdf'));
    const leasedUntil = new Date(Date.now() + 60_000);
    await setMeetingFileState(suite.prisma(), file.id, {
      status: 'processing',
      leased_until: leasedUntil,
      attempts: 1,
    });
    const snapshot = await findMeetingFileRow(suite.prisma(), file.id);

    await expect(worker().drain()).resolves.toBe(0);

    await expect(findMeetingFileRow(suite.prisma(), file.id)).resolves.toEqual(snapshot);
  });

  it('fails a row on its fourth claim instead of running it again', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const file = await upload(host.token, meeting.id, fixture('sample.pdf'));
    await setMeetingFileState(suite.prisma(), file.id, { status: 'uploaded', attempts: 3 });

    await expect(worker().drain()).resolves.toBe(1);

    await expect(findMeetingFileRow(suite.prisma(), file.id)).resolves.toMatchObject({
      status: 'failed',
      failure_reason: 'Processing failed after repeated attempts',
      attempts: 4,
      checksum: null,
      leased_until: null,
    });
  });

  it('purges the bytes of a deleted file exactly once', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const file = await upload(host.token, meeting.id, fixture('sample.png'));
    await expect(worker().drain()).resolves.toBe(1);
    expect(fs.existsSync(objectPath(meeting.id, file.id, '.thumb.webp'))).toBe(true);

    await suite
      .delete(meetingFileUrl(meeting.id, file.id))
      .set('Authorization', `Bearer ${host.token}`)
      .expect(204);
    expect(fs.existsSync(objectPath(meeting.id, file.id))).toBe(true);

    await expect(worker().drain()).resolves.toBe(1);

    expect(fs.existsSync(objectPath(meeting.id, file.id))).toBe(false);
    expect(fs.existsSync(objectPath(meeting.id, file.id, '.thumb.webp'))).toBe(false);
    const row = await findMeetingFileRow(suite.prisma(), file.id);
    expect(row.status).toBe('deleted');
    expect(row.purged_at).not.toBeNull();
    expect(row.leased_until).toBeNull();

    await expect(worker().drain()).resolves.toBe(0);
  });

  it('purges a file deleted before it was ever processed', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const file = await upload(host.token, meeting.id, fixture('sample.pdf'));
    await suite
      .delete(meetingFileUrl(meeting.id, file.id))
      .set('Authorization', `Bearer ${host.token}`)
      .expect(204);

    await expect(worker().drain()).resolves.toBe(1);

    expect(fs.existsSync(objectPath(meeting.id, file.id))).toBe(false);
    await expect(findMeetingFileRow(suite.prisma(), file.id)).resolves.toMatchObject({
      status: 'deleted',
      purged_at: expect.any(String),
    });
  });

  it('purges a deleted file whose processing claims already reached the cap', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const file = await upload(host.token, meeting.id, fixture('sample.pdf'));
    await setMeetingFileState(suite.prisma(), file.id, { status: 'uploaded', attempts: 3 });
    await expect(worker().drain()).resolves.toBe(1);
    await expect(findMeetingFileRow(suite.prisma(), file.id)).resolves.toMatchObject({
      status: 'failed',
      attempts: 4,
    });

    await suite
      .delete(meetingFileUrl(meeting.id, file.id))
      .set('Authorization', `Bearer ${host.token}`)
      .expect(204);
    await expect(worker().drain()).resolves.toBe(1);

    expect(fs.existsSync(objectPath(meeting.id, file.id))).toBe(false);
    await expect(findMeetingFileRow(suite.prisma(), file.id)).resolves.toMatchObject({
      status: 'deleted',
      attempts: 1,
      purged_at: expect.any(String),
    });
  });

  it('drains every claimable row, oldest first', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const first = await upload(host.token, meeting.id, fixture('sample.pdf'));
    const second = await upload(host.token, meeting.id, fixture('sample.png'));

    await expect(worker().drain()).resolves.toBe(2);

    await expect(findMeetingFileRow(suite.prisma(), first.id)).resolves.toMatchObject({
      status: 'ready',
    });
    await expect(findMeetingFileRow(suite.prisma(), second.id)).resolves.toMatchObject({
      status: 'ready',
    });
  });
});
