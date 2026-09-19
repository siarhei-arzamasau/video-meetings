import fs from 'node:fs';
import path from 'node:path';

import type { MeetingFile } from '@repo/shared';
import type request from 'supertest';

import { useApiSuite } from './utils/api-suite';
import {
  EMAIL,
  OTHER_EMAIL,
  THIRD_EMAIL,
  meetingFileContentUrl,
  meetingFileThumbnailUrl,
  meetingFilesDir,
  meetingFilesUrl,
} from './utils/fixtures';
import { messageOf } from './utils/http';
import { setMeetingFileState } from './utils/meeting-files-table';
import { createMeeting, postRawMultipart, registerUser } from './utils/meeting-files-suite';

const FIXTURES = path.join(__dirname, 'fixtures');
const fixture = (name: string): string => path.join(FIXTURES, name);

/** The RIFF/WEBP container's magic bytes: `RIFF....WEBP`. Enough to know it is a WebP. */
const WEBP_BYTES = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);

/** Collects a streamed body into a Buffer, since supertest only parses the types it knows. */
const asBuffer: Parameters<request.Test['parse']>[0] = (res, callback) => {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
};

describe('GET /api/meetings/:id/files/:fileId/content and /thumbnail', () => {
  const suite = useApiSuite();

  const upload = async (
    token: string,
    meetingId: string,
    file: string,
    filename?: string,
  ): Promise<MeetingFile> => {
    const response = await suite
      .postFile(meetingFilesUrl(meetingId), token, file, { filename })
      .expect(201);

    return response.body as MeetingFile;
  };

  const download = (token: string, meetingId: string, fileId: string) =>
    suite.get(meetingFileContentUrl(meetingId, fileId)).set('Authorization', `Bearer ${token}`);

  const thumbnail = (token: string, meetingId: string, fileId: string) =>
    suite.get(meetingFileThumbnailUrl(meetingId, fileId)).set('Authorization', `Bearer ${token}`);

  describe('content', () => {
    it('streams the stored bytes with the stored type and the download headers', async () => {
      const host = await registerUser(suite, EMAIL);
      const meeting = await createMeeting(suite, host);
      const bytes = fs.readFileSync(fixture('sample.png'));
      const file = await upload(host.token, meeting.id, fixture('sample.png'));

      const response = await download(host.token, meeting.id, file.id)
        .buffer(true)
        .parse(asBuffer)
        .expect(200);

      expect(response.headers['content-type']).toBe('image/png');
      expect(response.headers['content-length']).toBe(String(bytes.length));
      expect(response.headers['content-disposition']).toBe('attachment; filename="sample.png"');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect((response.body as Buffer).equals(bytes)).toBe(true);
    });

    it('round-trips a UTF-8 text file, served as an attachment', async () => {
      const host = await registerUser(suite, EMAIL);
      const meeting = await createMeeting(suite, host);
      const file = await upload(host.token, meeting.id, fixture('sample.md'));

      const response = await download(host.token, meeting.id, file.id).expect(200);

      expect(response.headers['content-type']).toBe('text/markdown');
      expect(response.headers['content-disposition']).toBe('attachment; filename="sample.md"');
      expect(response.text).toBe(fs.readFileSync(fixture('sample.md'), 'utf8'));
    });

    it('encodes a name with a quote and non-Latin-1 characters as both filename and filename*', async () => {
      const host = await registerUser(suite, EMAIL);
      const meeting = await createMeeting(suite, host);
      // Sent raw: `form-data` (like a browser) would percent-encode the quote before sending.
      const uploaded = await postRawMultipart(
        suite,
        meetingFilesUrl(meeting.id),
        host.token,
        'отчёт \\"final\\".pdf',
        fs.readFileSync(fixture('sample.pdf')),
      ).expect(201);
      const file = uploaded.body as MeetingFile;
      expect(file.name).toBe('отчёт "final".pdf');

      const response = await download(host.token, meeting.id, file.id).expect(200);

      expect(response.headers['content-disposition']).toBe(
        `attachment; filename="????? \\"final\\".pdf"; filename*=UTF-8''%D0%BE%D1%82%D1%87%D1%91%D1%82%20%22final%22.pdf`,
      );
    });

    it('lets a participant download', async () => {
      const host = await registerUser(suite, EMAIL);
      const participant = await registerUser(suite, OTHER_EMAIL);
      const meeting = await createMeeting(suite, host, [participant.id]);
      const file = await upload(host.token, meeting.id, fixture('sample.pdf'));

      await download(participant.token, meeting.id, file.id).expect(200);
    });

    it('answers 404 Meeting not found to a stranger', async () => {
      const host = await registerUser(suite, EMAIL);
      await registerUser(suite, OTHER_EMAIL);
      const stranger = await registerUser(suite, THIRD_EMAIL);
      const meeting = await createMeeting(suite, host);
      const file = await upload(host.token, meeting.id, fixture('sample.pdf'));

      const response = await download(stranger.token, meeting.id, file.id).expect(404);

      expect(messageOf(response)).toBe('Meeting not found');
    });

    it('answers 404 File not found for a file id that belongs to another meeting', async () => {
      const host = await registerUser(suite, EMAIL);
      const meeting = await createMeeting(suite, host);
      const other = await createMeeting(suite, host, [], 'Other');
      const file = await upload(host.token, other.id, fixture('sample.pdf'));

      const response = await download(host.token, meeting.id, file.id).expect(404);

      expect(messageOf(response)).toBe('File not found');
    });

    it('answers 401 without a token', async () => {
      const host = await registerUser(suite, EMAIL);
      const meeting = await createMeeting(suite, host);
      const file = await upload(host.token, meeting.id, fixture('sample.pdf'));

      await suite.get(meetingFileContentUrl(meeting.id, file.id)).expect(401);
    });

    it('rejects a file id that is not a uuid with 400', async () => {
      const host = await registerUser(suite, EMAIL);
      const meeting = await createMeeting(suite, host);

      await download(host.token, meeting.id, 'file-1').expect(400);
    });

    it('still downloads a file whose processing failed — failing to process is not losing it', async () => {
      const host = await registerUser(suite, EMAIL);
      const meeting = await createMeeting(suite, host);
      const file = await upload(host.token, meeting.id, fixture('sample.pdf'));
      await setMeetingFileState(suite.prisma(), file.id, { status: 'failed' });

      const response = await download(host.token, meeting.id, file.id).expect(200);

      expect(response.headers['content-type']).toBe('application/pdf');
    });

    it('answers 404 for a deleted file', async () => {
      const host = await registerUser(suite, EMAIL);
      const meeting = await createMeeting(suite, host);
      const file = await upload(host.token, meeting.id, fixture('sample.pdf'));
      await setMeetingFileState(suite.prisma(), file.id, { status: 'deleted' });

      const response = await download(host.token, meeting.id, file.id).expect(404);

      expect(messageOf(response)).toBe('File not found');
    });

    it('answers a 500 error body, not a hung socket, when the object is missing from disk', async () => {
      const host = await registerUser(suite, EMAIL);
      const meeting = await createMeeting(suite, host);
      const file = await upload(host.token, meeting.id, fixture('sample.pdf'));
      fs.unlinkSync(path.join(meetingFilesDir(), meeting.id, file.id));

      const response = await download(host.token, meeting.id, file.id).timeout(5_000).expect(500);

      expect(response.body).toEqual({
        statusCode: 500,
        message: expect.any(String),
        timestamp: expect.any(String),
        path: meetingFileContentUrl(meeting.id, file.id),
      });
    });
  });

  describe('thumbnail', () => {
    it('answers 404 Thumbnail not found when the file has none', async () => {
      const host = await registerUser(suite, EMAIL);
      const meeting = await createMeeting(suite, host);
      const file = await upload(host.token, meeting.id, fixture('sample.pdf'));

      const response = await thumbnail(host.token, meeting.id, file.id).expect(404);

      expect(messageOf(response)).toBe('Thumbnail not found');
    });

    it('serves the thumbnail inline as WebP with the same protective headers', async () => {
      const host = await registerUser(suite, EMAIL);
      const meeting = await createMeeting(suite, host);
      const file = await upload(host.token, meeting.id, fixture('sample.png'));
      const key = `${meeting.id}/${file.id}.thumb.webp`;
      fs.writeFileSync(path.join(meetingFilesDir(), key), WEBP_BYTES);
      await setMeetingFileState(suite.prisma(), file.id, { thumbnail_key: key });

      const response = await thumbnail(host.token, meeting.id, file.id)
        .buffer(true)
        .parse(asBuffer)
        .expect(200);

      expect(response.headers['content-type']).toBe('image/webp');
      expect(response.headers['content-length']).toBe(String(WEBP_BYTES.length));
      expect(response.headers['content-disposition']).toMatch(/^inline; filename="/);
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect((response.body as Buffer).equals(WEBP_BYTES)).toBe(true);
    });

    it('answers 404 Meeting not found to a stranger, even for a file with a thumbnail', async () => {
      const host = await registerUser(suite, EMAIL);
      await registerUser(suite, OTHER_EMAIL);
      const stranger = await registerUser(suite, THIRD_EMAIL);
      const meeting = await createMeeting(suite, host);
      const file = await upload(host.token, meeting.id, fixture('sample.png'));
      const key = `${meeting.id}/${file.id}.thumb.webp`;
      fs.writeFileSync(path.join(meetingFilesDir(), key), WEBP_BYTES);
      await setMeetingFileState(suite.prisma(), file.id, { thumbnail_key: key });

      const response = await thumbnail(stranger.token, meeting.id, file.id).expect(404);

      expect(messageOf(response)).toBe('Meeting not found');
    });

    it('answers 404 for a deleted file', async () => {
      const host = await registerUser(suite, EMAIL);
      const meeting = await createMeeting(suite, host);
      const file = await upload(host.token, meeting.id, fixture('sample.png'));
      await setMeetingFileState(suite.prisma(), file.id, { status: 'deleted' });

      const response = await thumbnail(host.token, meeting.id, file.id).expect(404);

      expect(messageOf(response)).toBe('File not found');
    });
  });
});
