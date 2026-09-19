import fs from 'node:fs';
import path from 'node:path';

import type { MeetingFile } from '@repo/shared';
import request from 'supertest';

import { useApiSuite } from './utils/api-suite';
import {
  EMAIL,
  MAX_MEETING_FILES,
  MAX_MEETING_FILE_NAME_LENGTH,
  MAX_MEETING_FILE_SIZE_BYTES,
  OTHER_EMAIL,
  THIRD_EMAIL,
  meetingFilesDir,
  meetingFilesUrl,
} from './utils/fixtures';
import { messageOf } from './utils/http';
import {
  countMeetingFiles,
  findMeetingFileRow,
  insertMeetingFileRow,
} from './utils/meeting-files-table';
import { createMeeting, registerUser } from './utils/meeting-files-suite';

const FIXTURES = path.join(__dirname, 'fixtures');
const fixture = (name: string): string => path.join(FIXTURES, name);

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const WORD_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const tempDirEntries = (): string[] => {
  const tmp = path.join(meetingFilesDir(), 'tmp');

  return fs.existsSync(tmp) ? fs.readdirSync(tmp) : [];
};

const objectsOf = (meetingId: string): string[] => {
  const dir = path.join(meetingFilesDir(), meetingId);

  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};

/** Seeds `count` rows directly, for the cap cases. */
const seedFiles = (
  suite: ReturnType<typeof useApiSuite>,
  meetingId: string,
  uploaderId: string,
  count: number,
  rowFor: (index: number) => { status?: string; deleted_at?: Date | null } = () => ({}),
): Promise<string[]> =>
  Promise.all(
    Array.from({ length: count }, (_, index) =>
      insertMeetingFileRow(suite.prisma(), {
        meeting_id: meetingId,
        uploader_id: uploaderId,
        ...rowFor(index),
      }),
    ),
  );

describe('POST /api/meetings/:id/files', () => {
  const suite = useApiSuite();

  const upload = (token: string, meetingId: string, file: string | Buffer, filename?: string) =>
    suite.postFile(meetingFilesUrl(meetingId), token, file, { filename });

  it('stores the file, writes the record, and reports it as uploaded', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const bytes = fs.readFileSync(fixture('sample.png'));

    const response = await upload(host.token, meeting.id, fixture('sample.png')).expect(201);
    const body = response.body as MeetingFile;

    expect(Object.keys(body).toSorted()).toEqual([
      'contentType',
      'createdAt',
      'id',
      'meetingId',
      'name',
      'size',
      'status',
      'uploaderId',
    ]);
    expect(body).toEqual({
      id: expect.any(String),
      meetingId: meeting.id,
      uploaderId: host.id,
      name: 'sample.png',
      contentType: 'image/png',
      size: bytes.length,
      status: 'uploaded',
      createdAt: expect.stringMatching(ISO_INSTANT),
    });

    const row = await findMeetingFileRow(suite.prisma(), body.id);
    expect(row).toMatchObject({
      storage_key: `${meeting.id}/${body.id}`,
      status: 'uploaded',
      checksum: null,
      thumbnail_key: null,
      attempts: 0,
      leased_until: null,
      processed_at: null,
      deleted_at: null,
      purged_at: null,
    });

    const stored = path.join(meetingFilesDir(), meeting.id, body.id);
    expect(fs.readFileSync(stored).equals(bytes)).toBe(true);
    expect(tempDirEntries()).toEqual([]);
  });

  it.each([
    ['sample.pdf', 'application/pdf'],
    ['sample.txt', 'text/plain'],
    ['sample.md', 'text/markdown'],
    ['sample.csv', 'text/csv'],
    ['sample.docx', WORD_TYPE],
  ])('sniffs %s as %s', async (name, contentType) => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);

    const response = await upload(host.token, meeting.id, fixture(name)).expect(201);

    expect(response.body).toMatchObject({ name, contentType });
  });

  it('stores an HTML file named .txt as plain text — the extension picks only among text types', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);

    const response = await upload(host.token, meeting.id, fixture('page.html'), 'notes.txt').expect(
      201,
    );

    expect(response.body).toMatchObject({ name: 'notes.txt', contentType: 'text/plain' });
  });

  it('round-trips a UTF-8 file name exactly', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);

    const response = await upload(
      host.token,
      meeting.id,
      fixture('sample.pdf'),
      'отчёт.pdf',
    ).expect(201);

    expect((response.body as MeetingFile).name).toBe('отчёт.pdf');
    await expect(
      findMeetingFileRow(suite.prisma(), (response.body as MeetingFile).id),
    ).resolves.toMatchObject({
      name: 'отчёт.pdf',
    });
  });

  it('trims the name before storing it', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);

    const response = await upload(
      host.token,
      meeting.id,
      fixture('sample.pdf'),
      '  deck.pdf  ',
    ).expect(201);

    expect((response.body as MeetingFile).name).toBe('deck.pdf');
  });

  it('lets a participant upload', async () => {
    const host = await registerUser(suite, EMAIL);
    const participant = await registerUser(suite, OTHER_EMAIL);
    const meeting = await createMeeting(suite, host, [participant.id]);

    const response = await upload(participant.token, meeting.id, fixture('sample.pdf')).expect(201);

    expect((response.body as MeetingFile).uploaderId).toBe(participant.id);
  });

  it('answers 404 Meeting not found to a stranger, storing nothing', async () => {
    const host = await registerUser(suite, EMAIL);
    await registerUser(suite, OTHER_EMAIL);
    const stranger = await registerUser(suite, THIRD_EMAIL);
    const meeting = await createMeeting(suite, host);

    const response = await upload(stranger.token, meeting.id, fixture('sample.pdf')).expect(404);

    expect(messageOf(response)).toBe('Meeting not found');
    await expect(countMeetingFiles(suite.prisma())).resolves.toBe(0);
    expect(objectsOf(meeting.id)).toEqual([]);
    expect(tempDirEntries()).toEqual([]);
  });

  it('answers 401 without a valid token, before the body is looked at', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);

    // A JSON body rather than a file part: the guard answers before the request body is
    // consumed, and a client still streaming a multipart body sees the socket close under it.
    await suite
      .post(meetingFilesUrl(meeting.id), {})
      .set('Authorization', 'Bearer not-a-token')
      .expect(401);
    await suite.post(meetingFilesUrl(meeting.id), {}).expect(401);
    expect(tempDirEntries()).toEqual([]);
  });

  it('rejects a meeting id that is not a uuid with 400, leaving no temp file', async () => {
    const host = await registerUser(suite, EMAIL);

    await upload(host.token, 'meeting-1', fixture('sample.pdf')).expect(400);
    expect(tempDirEntries()).toEqual([]);
  });

  describe('rejections', () => {
    it('400 when no file part is sent', async () => {
      const host = await registerUser(suite, EMAIL);
      const meeting = await createMeeting(suite, host);

      const response = await suite
        .post(meetingFilesUrl(meeting.id), {})
        .set('Authorization', `Bearer ${host.token}`)
        .expect(400);

      expect(messageOf(response)).toBe('A file is required');
      await expect(countMeetingFiles(suite.prisma())).resolves.toBe(0);
    });

    it('400 when the file part has another field name', async () => {
      const host = await registerUser(suite, EMAIL);
      const meeting = await createMeeting(suite, host);

      await suite
        .postFile(meetingFilesUrl(meeting.id), host.token, fixture('sample.pdf'), {
          fieldName: 'attachment',
        })
        .expect(400);
      await expect(countMeetingFiles(suite.prisma())).resolves.toBe(0);
      expect(tempDirEntries()).toEqual([]);
    });

    it('400 The file is empty for zero bytes', async () => {
      const host = await registerUser(suite, EMAIL);
      const meeting = await createMeeting(suite, host);

      const response = await upload(host.token, meeting.id, Buffer.alloc(0), 'empty.txt').expect(
        400,
      );

      expect(messageOf(response)).toBe('The file is empty');
      await expect(countMeetingFiles(suite.prisma())).resolves.toBe(0);
      expect(tempDirEntries()).toEqual([]);
    });

    it('400 for a forward slash, sent as a raw multipart body because form-data strips one', async () => {
      const host = await registerUser(suite, EMAIL);
      const meeting = await createMeeting(suite, host);
      const boundary = 'raw-boundary-9f2c';
      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a/b.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
        ),
        fs.readFileSync(fixture('sample.pdf')),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);

      const response = await request(suite.app().getHttpServer())
        .post(meetingFilesUrl(meeting.id))
        .set('Authorization', `Bearer ${host.token}`)
        .set('Content-Type', `multipart/form-data; boundary=${boundary}`)
        .send(body)
        .expect(400);

      expect(messageOf(response)).toBe(
        'The file name must be 1–255 characters and contain no path separators',
      );
      await expect(countMeetingFiles(suite.prisma())).resolves.toBe(0);
      expect(objectsOf(meeting.id)).toEqual([]);
      expect(tempDirEntries()).toEqual([]);
    });

    it.each([
      ['a backslash', 'a\\b.pdf'],
      ['a blank name', '   '],
      ['an over-long name', `${'a'.repeat(MAX_MEETING_FILE_NAME_LENGTH - 3)}.pdf`],
    ])('400 for %s', async (_description, filename) => {
      const host = await registerUser(suite, EMAIL);
      const meeting = await createMeeting(suite, host);

      const response = await upload(host.token, meeting.id, fixture('sample.pdf'), filename).expect(
        400,
      );

      expect(messageOf(response)).toBe(
        'The file name must be 1–255 characters and contain no path separators',
      );
      await expect(countMeetingFiles(suite.prisma())).resolves.toBe(0);
      expect(objectsOf(meeting.id)).toEqual([]);
      expect(tempDirEntries()).toEqual([]);
    });

    it('415 for an HTML file renamed .pdf — the extension never elevates a type', async () => {
      const host = await registerUser(suite, EMAIL);
      const meeting = await createMeeting(suite, host);

      const response = await upload(
        host.token,
        meeting.id,
        fixture('page.html'),
        'page.pdf',
      ).expect(415);

      expect(messageOf(response)).toBe('That file type is not supported.');
      await expect(countMeetingFiles(suite.prisma())).resolves.toBe(0);
      expect(objectsOf(meeting.id)).toEqual([]);
      expect(tempDirEntries()).toEqual([]);
    });

    it('415 for an HTML file under its own name', async () => {
      const host = await registerUser(suite, EMAIL);
      const meeting = await createMeeting(suite, host);

      const response = await upload(host.token, meeting.id, fixture('page.html')).expect(415);

      expect(messageOf(response)).toBe('That file type is not supported.');
      expect(tempDirEntries()).toEqual([]);
    });

    it('415 for binary bytes with a text extension', async () => {
      const host = await registerUser(suite, EMAIL);
      const meeting = await createMeeting(suite, host);

      const response = await upload(
        host.token,
        meeting.id,
        Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]),
        'notes.txt',
      ).expect(415);

      expect(messageOf(response)).toBe('That file type is not supported.');
      expect(tempDirEntries()).toEqual([]);
    });

    it(`409 for the ${String(MAX_MEETING_FILES + 1)}th file`, async () => {
      const host = await registerUser(suite, EMAIL);
      const meeting = await createMeeting(suite, host);
      await seedFiles(suite, meeting.id, host.id, MAX_MEETING_FILES);

      const response = await upload(host.token, meeting.id, fixture('sample.pdf')).expect(409);

      expect(messageOf(response)).toBe(
        `This meeting already has ${String(MAX_MEETING_FILES)} files.`,
      );
      await expect(countMeetingFiles(suite.prisma())).resolves.toBe(MAX_MEETING_FILES);
      expect(objectsOf(meeting.id)).toEqual([]);
      expect(tempDirEntries()).toEqual([]);
    });

    it('does not count deleted files against the cap', async () => {
      const host = await registerUser(suite, EMAIL);
      const meeting = await createMeeting(suite, host);
      await seedFiles(suite, meeting.id, host.id, MAX_MEETING_FILES, (index) => ({
        status: index === 0 ? 'deleted' : 'ready',
        deleted_at: index === 0 ? new Date() : null,
      }));

      await upload(host.token, meeting.id, fixture('sample.pdf')).expect(201);
    });
  });

  describe('the size cap', () => {
    // One byte over the cap, so the bound itself is what is asserted.
    const oversized = Buffer.alloc(MAX_MEETING_FILE_SIZE_BYTES + 1);

    it('413 Files must be 100 MB or smaller.', async () => {
      const host = await registerUser(suite, EMAIL);
      const meeting = await createMeeting(suite, host);

      const response = await upload(host.token, meeting.id, oversized, 'big.bin').expect(413);

      expect(messageOf(response)).toBe('Files must be 100 MB or smaller.');
      await expect(countMeetingFiles(suite.prisma())).resolves.toBe(0);
      expect(objectsOf(meeting.id)).toEqual([]);
      expect(tempDirEntries()).toEqual([]);
    }, 60_000);
  });

  describe('concurrency', () => {
    it('enforces the cap in a transaction: parallel uploads at the edge yield exactly one 201', async () => {
      const host = await registerUser(suite, EMAIL);
      const meeting = await createMeeting(suite, host);
      await seedFiles(suite, meeting.id, host.id, MAX_MEETING_FILES - 1);

      const responses = await Promise.all(
        Array.from({ length: MAX_MEETING_FILES }, () =>
          upload(host.token, meeting.id, fixture('sample.pdf')),
        ),
      );
      const statuses = responses.map(({ status }) => status).toSorted();

      expect(statuses).toEqual([201, ...Array.from({ length: MAX_MEETING_FILES - 1 }, () => 409)]);
      await expect(countMeetingFiles(suite.prisma())).resolves.toBe(MAX_MEETING_FILES);
      expect(objectsOf(meeting.id)).toHaveLength(1);
      expect(tempDirEntries()).toEqual([]);
    }, 60_000);
  });

  it('shows uploads in the list newest first', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);

    const first = await upload(host.token, meeting.id, fixture('sample.pdf')).expect(201);
    const second = await upload(host.token, meeting.id, fixture('sample.png')).expect(201);

    const response = await suite
      .get(meetingFilesUrl(meeting.id))
      .set('Authorization', `Bearer ${host.token}`)
      .expect(200);
    const ids = (response.body as MeetingFile[]).map(({ id }) => id);

    // Two uploads in sequence have distinct created_at instants at millisecond precision only
    // if the requests are slow enough; the tie-break on id descending covers the other case.
    const expected = [second.body as MeetingFile, first.body as MeetingFile]
      .toSorted((a, b) => {
        const byInstant = Date.parse(b.createdAt) - Date.parse(a.createdAt);

        return byInstant !== 0 ? byInstant : a.id < b.id ? 1 : -1;
      })
      .map(({ id }) => id);
    expect(ids).toEqual(expected);
  });
});
