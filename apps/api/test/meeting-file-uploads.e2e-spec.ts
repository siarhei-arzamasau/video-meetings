import fs from 'node:fs';
import path from 'node:path';

import type { INestApplication } from '@nestjs/common';
import type { MeetingFile, MeetingFileUpload } from '@repo/shared';
import request from 'supertest';

import { useApiSuite } from './utils/api-suite';
import { createTestApp } from './utils/create-test-app';
import {
  EMAIL,
  MAX_CHUNKED_MEETING_FILE_SIZE_BYTES,
  MAX_MEETING_FILES,
  MAX_MEETING_FILE_NAME_LENGTH,
  MEETING_FILE_CHUNK_SIZE_BYTES,
  OTHER_EMAIL,
  THIRD_EMAIL,
  meetingFileChunkUrl,
  meetingFileUploadUrl,
  meetingFileUploadsUrl,
  meetingFilesDir,
  meetingFilesUrl,
} from './utils/fixtures';
import { messageOf } from './utils/http';
import {
  countMeetingFileUploads,
  findMeetingFileUploadRow,
  setMeetingFileUploadState,
} from './utils/meeting-file-uploads-table';
import { countMeetingFiles, insertMeetingFileRow } from './utils/meeting-files-table';
import { createMeeting, putBytes, registerUser } from './utils/meeting-files-suite';

const CHUNK = MEETING_FILE_CHUNK_SIZE_BYTES;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const NAME_MESSAGE = 'The file name must be 1–255 characters and contain no path separators';
const SIZE_MESSAGE = 'The file size must be a positive number of bytes';

/** Deterministic bytes, so a chunk read back off disk can be compared to what was sent. */
const filled = (length: number, byte: number): Buffer => Buffer.alloc(length, byte);

const chunkDirOf = (uploadId: string): string => path.join(meetingFilesDir(), 'uploads', uploadId);

const chunksOnDisk = (uploadId: string): string[] => {
  const dir = chunkDirOf(uploadId);

  return fs.existsSync(dir) ? fs.readdirSync(dir).toSorted() : [];
};

const tempDirEntries = (): string[] => {
  const tmp = path.join(meetingFilesDir(), 'tmp');

  return fs.existsSync(tmp) ? fs.readdirSync(tmp) : [];
};

describe('chunked upload sessions', () => {
  const suite = useApiSuite();

  const createSession = (token: string, meetingId: string, body: object) =>
    suite.post(meetingFileUploadsUrl(meetingId), body).set('Authorization', `Bearer ${token}`);

  const readSession = (token: string, meetingId: string, uploadId: string) =>
    suite.get(meetingFileUploadUrl(meetingId, uploadId)).set('Authorization', `Bearer ${token}`);

  const sendChunk = (
    token: string,
    meetingId: string,
    uploadId: string,
    index: number,
    bytes: Buffer,
  ) => putBytes(suite, meetingFileChunkUrl(meetingId, uploadId, index), token, bytes);

  /** Seeds `count` file rows directly, for the cap case. */
  const seedFiles = (meetingId: string, uploaderId: string, count: number): Promise<string[]> =>
    Promise.all(
      Array.from({ length: count }, () =>
        insertMeetingFileRow(suite.prisma(), { meeting_id: meetingId, uploader_id: uploaderId }),
      ),
    );

  describe('POST /api/meetings/:id/files/uploads', () => {
    it('opens a session with the server chunk plan and nothing received yet', async () => {
      const host = await registerUser(suite, EMAIL);
      const meeting = await createMeeting(suite, host);

      const response = await createSession(host.token, meeting.id, {
        name: 'recording.mp4',
        size: 2 * CHUNK + 1,
      }).expect(201);
      const body = response.body as MeetingFileUpload;

      expect(Object.keys(body).toSorted()).toEqual([
        'chunkCount',
        'chunkSize',
        'createdAt',
        'expiresAt',
        'id',
        'meetingId',
        'name',
        'receivedChunks',
        'size',
      ]);
      expect(body).toEqual({
        id: expect.any(String),
        meetingId: meeting.id,
        name: 'recording.mp4',
        size: 2 * CHUNK + 1,
        chunkSize: CHUNK,
        chunkCount: 3,
        receivedChunks: [],
        createdAt: expect.stringMatching(ISO_INSTANT),
        expiresAt: expect.stringMatching(ISO_INSTANT),
      });

      const row = await findMeetingFileUploadRow(suite.prisma(), body.id);
      expect(row).toMatchObject({
        meeting_id: meeting.id,
        uploader_id: host.id,
        name: 'recording.mp4',
        chunk_size: CHUNK,
        chunk_count: 3,
        received_chunks: [],
        attempts: 0,
        leased_until: null,
        purged_at: null,
      });

      // The default TTL is 24 hours. `createdAt` is the database's `now()` and `expiresAt` is
      // computed in the handler a few milliseconds earlier, so the two differ by about a day
      // rather than exactly one — what matters is that it is a day out and not in the past.
      const ttlMs = Date.parse(body.expiresAt) - Date.parse(body.createdAt);
      expect(ttlMs).toBeGreaterThan(24 * 60 * 60 * 1_000 - 5_000);
      expect(ttlMs).toBeLessThanOrEqual(24 * 60 * 60 * 1_000);
      // No chunk has been sent, so nothing exists on disk for it yet.
      expect(fs.existsSync(chunkDirOf(body.id))).toBe(false);
    });

    it('creates no file: a session is invisible to the meeting until it completes', async () => {
      const host = await registerUser(suite, EMAIL);
      const meeting = await createMeeting(suite, host);

      await createSession(host.token, meeting.id, { name: 'big.mp4', size: CHUNK }).expect(201);

      const files = await suite
        .get(meetingFilesUrl(meeting.id))
        .set('Authorization', `Bearer ${host.token}`)
        .expect(200);

      expect(files.body as MeetingFile[]).toEqual([]);
      await expect(countMeetingFiles(suite.prisma())).resolves.toBe(0);
    });

    it('trims the name and round-trips UTF-8 exactly', async () => {
      const host = await registerUser(suite, EMAIL);
      const meeting = await createMeeting(suite, host);

      const response = await createSession(host.token, meeting.id, {
        name: '  отчёт.mp4  ',
        size: 10,
      }).expect(201);

      expect((response.body as MeetingFileUpload).name).toBe('отчёт.mp4');
    });

    it('plans one chunk for a file smaller than the chunk size', async () => {
      const host = await registerUser(suite, EMAIL);
      const meeting = await createMeeting(suite, host);

      const response = await createSession(host.token, meeting.id, {
        name: 'small.bin',
        size: 5,
      }).expect(201);

      expect(response.body as MeetingFileUpload).toMatchObject({ chunkCount: 1, size: 5 });
    });

    it('lets a participant open a session', async () => {
      const host = await registerUser(suite, EMAIL);
      const participant = await registerUser(suite, OTHER_EMAIL);
      const meeting = await createMeeting(suite, host, [participant.id]);

      const response = await createSession(participant.token, meeting.id, {
        name: 'clip.mp4',
        size: 10,
      }).expect(201);

      await expect(
        findMeetingFileUploadRow(suite.prisma(), (response.body as MeetingFileUpload).id),
      ).resolves.toMatchObject({ uploader_id: participant.id });
    });

    it('answers 404 Meeting not found to a stranger, writing nothing', async () => {
      const host = await registerUser(suite, EMAIL);
      await registerUser(suite, OTHER_EMAIL);
      const stranger = await registerUser(suite, THIRD_EMAIL);
      const meeting = await createMeeting(suite, host);

      const response = await createSession(stranger.token, meeting.id, {
        name: 'clip.mp4',
        size: 10,
      }).expect(404);

      expect(messageOf(response)).toBe('Meeting not found');
      await expect(countMeetingFileUploads(suite.prisma())).resolves.toBe(0);
    });

    it('answers 401 without a valid token', async () => {
      const host = await registerUser(suite, EMAIL);
      const meeting = await createMeeting(suite, host);

      await suite
        .post(meetingFileUploadsUrl(meeting.id), { name: 'clip.mp4', size: 10 })
        .set('Authorization', 'Bearer not-a-token')
        .expect(401);
      await suite
        .post(meetingFileUploadsUrl(meeting.id), { name: 'clip.mp4', size: 10 })
        .expect(401);
    });

    it('rejects a meeting id that is not a uuid with 400', async () => {
      const host = await registerUser(suite, EMAIL);

      await createSession(host.token, 'meeting-1', { name: 'clip.mp4', size: 10 }).expect(400);
    });

    describe('rejections', () => {
      it.each([
        ['zero', 0],
        ['a negative size', -1],
        ['a fractional size', 1.5],
      ])('400 for %s', async (_description, size) => {
        const host = await registerUser(suite, EMAIL);
        const meeting = await createMeeting(suite, host);

        const response = await createSession(host.token, meeting.id, {
          name: 'clip.mp4',
          size,
        }).expect(400);

        // A non-integer is the DTO's rejection (an array of messages); zero and a negative
        // are integers, so they reach the handler's own check. The words are the same either
        // way, which is the part the contract names.
        expect([messageOf(response)].flat()).toContain(SIZE_MESSAGE);
        await expect(countMeetingFileUploads(suite.prisma())).resolves.toBe(0);
      });

      it('400 for a size sent as a string — implicit conversion is off', async () => {
        const host = await registerUser(suite, EMAIL);
        const meeting = await createMeeting(suite, host);

        await createSession(host.token, meeting.id, { name: 'clip.mp4', size: '10' }).expect(400);
        await expect(countMeetingFileUploads(suite.prisma())).resolves.toBe(0);
      });

      it(`413 for one byte over the ${String(MAX_CHUNKED_MEETING_FILE_SIZE_BYTES)} byte cap`, async () => {
        const host = await registerUser(suite, EMAIL);
        const meeting = await createMeeting(suite, host);

        const response = await createSession(host.token, meeting.id, {
          name: 'huge.mp4',
          size: MAX_CHUNKED_MEETING_FILE_SIZE_BYTES + 1,
        }).expect(413);

        expect(messageOf(response)).toBe('Files must be 1 GB or smaller.');
        await expect(countMeetingFileUploads(suite.prisma())).resolves.toBe(0);
      });

      it('accepts the cap itself', async () => {
        const host = await registerUser(suite, EMAIL);
        const meeting = await createMeeting(suite, host);

        const response = await createSession(host.token, meeting.id, {
          name: 'huge.mp4',
          size: MAX_CHUNKED_MEETING_FILE_SIZE_BYTES,
        }).expect(201);

        expect((response.body as MeetingFileUpload).chunkCount).toBe(
          MAX_CHUNKED_MEETING_FILE_SIZE_BYTES / CHUNK,
        );
      });

      it.each([
        ['a forward slash', 'a/b.mp4'],
        ['a backslash', 'a\\b.mp4'],
        ['a blank name', '   '],
        ['an over-long name', `${'a'.repeat(MAX_MEETING_FILE_NAME_LENGTH - 3)}.mp4`],
      ])('400 for %s, with the same message the single-request path gives', async (_d, name) => {
        const host = await registerUser(suite, EMAIL);
        const meeting = await createMeeting(suite, host);

        const response = await createSession(host.token, meeting.id, { name, size: 10 }).expect(
          400,
        );

        expect(messageOf(response)).toBe(NAME_MESSAGE);
        await expect(countMeetingFileUploads(suite.prisma())).resolves.toBe(0);
      });

      it(`409 when the meeting already holds ${String(MAX_MEETING_FILES)} files`, async () => {
        const host = await registerUser(suite, EMAIL);
        const meeting = await createMeeting(suite, host);
        await seedFiles(meeting.id, host.id, MAX_MEETING_FILES);

        const response = await createSession(host.token, meeting.id, {
          name: 'clip.mp4',
          size: 10,
        }).expect(409);

        expect(messageOf(response)).toBe(
          `This meeting already has ${String(MAX_MEETING_FILES)} files.`,
        );
        await expect(countMeetingFileUploads(suite.prisma())).resolves.toBe(0);
      });
    });
  });

  describe('PUT /api/meetings/:id/files/uploads/:uploadId/chunks/:index', () => {
    it('stores chunks sent out of order and reports them ascending', async () => {
      const host = await registerUser(suite, EMAIL);
      const meeting = await createMeeting(suite, host);
      const size = 2 * CHUNK + 3;
      const created = await createSession(host.token, meeting.id, {
        name: 'recording.mp4',
        size,
      }).expect(201);
      const { id } = created.body as MeetingFileUpload;

      await sendChunk(host.token, meeting.id, id, 2, filled(3, 0x02)).expect(204);
      let status = await readSession(host.token, meeting.id, id).expect(200);
      expect((status.body as MeetingFileUpload).receivedChunks).toEqual([2]);

      await sendChunk(host.token, meeting.id, id, 0, filled(CHUNK, 0x00)).expect(204);
      status = await readSession(host.token, meeting.id, id).expect(200);
      expect((status.body as MeetingFileUpload).receivedChunks).toEqual([0, 2]);

      await sendChunk(host.token, meeting.id, id, 1, filled(CHUNK, 0x01)).expect(204);
      status = await readSession(host.token, meeting.id, id).expect(200);
      expect((status.body as MeetingFileUpload).receivedChunks).toEqual([0, 1, 2]);

      // The bytes are on disk under the documented keys, and are the bytes that were sent.
      expect(chunksOnDisk(id)).toEqual(['0', '1', '2']);
      expect(fs.readFileSync(path.join(chunkDirOf(id), '2'))).toEqual(filled(3, 0x02));
      expect(fs.statSync(path.join(chunkDirOf(id), '0')).size).toBe(CHUNK);
      expect(tempDirEntries()).toEqual([]);
      // Still no file: the bytes are complete but nothing has assembled them.
      await expect(countMeetingFiles(suite.prisma())).resolves.toBe(0);
    }, 60_000);

    it('is idempotent: the same chunk twice leaves one entry and one file', async () => {
      const host = await registerUser(suite, EMAIL);
      const meeting = await createMeeting(suite, host);
      const created = await createSession(host.token, meeting.id, {
        name: 'clip.mp4',
        size: 4,
      }).expect(201);
      const { id } = created.body as MeetingFileUpload;

      await sendChunk(host.token, meeting.id, id, 0, filled(4, 0x07)).expect(204);
      await sendChunk(host.token, meeting.id, id, 0, filled(4, 0x09)).expect(204);

      const status = await readSession(host.token, meeting.id, id).expect(200);
      expect((status.body as MeetingFileUpload).receivedChunks).toEqual([0]);
      expect(chunksOnDisk(id)).toEqual(['0']);
      // The later bytes win; the checksum the verify step computes is what guarantees the
      // assembled file is what the client meant to send.
      expect(fs.readFileSync(path.join(chunkDirOf(id), '0'))).toEqual(filled(4, 0x09));
    });

    it.each([
      ['one past the last index', '1'],
      ['a word', 'abc'],
      ['a negative index', '-1'],
      ['a leading zero', '00'],
    ])('400 Chunk index out of range for %s', async (_description, index) => {
      const host = await registerUser(suite, EMAIL);
      const meeting = await createMeeting(suite, host);
      const created = await createSession(host.token, meeting.id, {
        name: 'clip.mp4',
        size: 4,
      }).expect(201);
      const { id } = created.body as MeetingFileUpload;

      const response = await putBytes(
        suite,
        `${meetingFileUploadUrl(meeting.id, id)}/chunks/${index}`,
        host.token,
        filled(4, 0x01),
      ).expect(400);

      expect(messageOf(response)).toBe('Chunk index out of range');
      expect(chunksOnDisk(id)).toEqual([]);
      expect(tempDirEntries()).toEqual([]);
    });

    it.each([
      ['a short chunk', 3],
      ['a long chunk', 5],
      ['an empty body', 0],
    ])('400 Chunk length does not match for %s', async (_description, length) => {
      const host = await registerUser(suite, EMAIL);
      const meeting = await createMeeting(suite, host);
      const created = await createSession(host.token, meeting.id, {
        name: 'clip.mp4',
        size: 4,
      }).expect(201);
      const { id } = created.body as MeetingFileUpload;

      const response = await sendChunk(host.token, meeting.id, id, 0, filled(length, 0x01)).expect(
        400,
      );

      expect(messageOf(response)).toBe('Chunk length does not match');
      expect(chunksOnDisk(id)).toEqual([]);
      await expect(findMeetingFileUploadRow(suite.prisma(), id)).resolves.toMatchObject({
        received_chunks: [],
      });
    });

    it('400 for a non-final chunk that is not exactly one chunk long', async () => {
      const host = await registerUser(suite, EMAIL);
      const meeting = await createMeeting(suite, host);
      const created = await createSession(host.token, meeting.id, {
        name: 'recording.mp4',
        size: CHUNK + 10,
      }).expect(201);
      const { id } = created.body as MeetingFileUpload;

      const response = await sendChunk(host.token, meeting.id, id, 0, filled(10, 0x01)).expect(400);

      expect(messageOf(response)).toBe('Chunk length does not match');
    }, 30_000);
  });

  describe('a session belongs to the one person who opened it', () => {
    const openSession = async (): Promise<{
      host: { id: string; token: string };
      other: { id: string; token: string };
      meetingId: string;
      uploadId: string;
    }> => {
      const host = await registerUser(suite, EMAIL);
      const other = await registerUser(suite, OTHER_EMAIL);
      const meeting = await createMeeting(suite, host, [other.id]);
      const created = await createSession(host.token, meeting.id, {
        name: 'clip.mp4',
        size: 4,
      }).expect(201);

      return {
        host,
        other,
        meetingId: meeting.id,
        uploadId: (created.body as MeetingFileUpload).id,
      };
    };

    it('404 when another participant of the same meeting reads it', async () => {
      const { other, meetingId, uploadId } = await openSession();

      const response = await readSession(other.token, meetingId, uploadId).expect(404);

      expect(messageOf(response)).toBe('Upload not found');
    });

    it('404 when another participant writes a chunk to it, storing nothing', async () => {
      const { other, meetingId, uploadId } = await openSession();

      const response = await sendChunk(other.token, meetingId, uploadId, 0, filled(4, 0x01)).expect(
        404,
      );

      expect(messageOf(response)).toBe('Upload not found');
      expect(chunksOnDisk(uploadId)).toEqual([]);
    });

    it('404 for an id that is not a session of this meeting', async () => {
      const { host, uploadId } = await openSession();
      const otherMeeting = await createMeeting(suite, host, [], 'Another meeting');

      await readSession(host.token, otherMeeting.id, uploadId).expect(404);
    });

    it('404 once the session has expired, for reads and for chunks alike', async () => {
      const { host, meetingId, uploadId } = await openSession();
      await setMeetingFileUploadState(suite.prisma(), uploadId, {
        expires_at: new Date(Date.now() - 1_000),
      });

      const read = await readSession(host.token, meetingId, uploadId).expect(404);
      const write = await sendChunk(host.token, meetingId, uploadId, 0, filled(4, 0x01)).expect(
        404,
      );

      expect(messageOf(read)).toBe('Upload not found');
      expect(messageOf(write)).toBe('Upload not found');
      expect(chunksOnDisk(uploadId)).toEqual([]);
    });

    it('404 to a stranger, who is told about the meeting and never about the session', async () => {
      const { meetingId, uploadId } = await openSession();
      const stranger = await registerUser(suite, THIRD_EMAIL);

      const response = await readSession(stranger.token, meetingId, uploadId).expect(404);

      expect(messageOf(response)).toBe('Meeting not found');
    });

    it('401 without a valid token', async () => {
      const { meetingId, uploadId } = await openSession();

      await suite.get(meetingFileUploadUrl(meetingId, uploadId)).expect(401);
    });
  });

  it('survives a restart: a rebooted API reports the chunks the old one acknowledged', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const created = await createSession(host.token, meeting.id, {
      name: 'clip.mp4',
      size: 4,
    }).expect(201);
    const { id } = created.body as MeetingFileUpload;
    await sendChunk(host.token, meeting.id, id, 0, filled(4, 0x05)).expect(204);

    // A second application against the same database and the same storage root: everything a
    // restart preserves, and nothing that only lived in the first process's memory.
    const rebooted: INestApplication = await createTestApp();

    try {
      const response = await request(rebooted.getHttpServer())
        .get(meetingFileUploadUrl(meeting.id, id))
        .set('Authorization', `Bearer ${host.token}`)
        .expect(200);

      expect(response.body as MeetingFileUpload).toMatchObject({
        id,
        receivedChunks: [0],
        chunkCount: 1,
      });
    } finally {
      await rebooted.close();
    }

    expect(fs.readFileSync(path.join(chunkDirOf(id), '0'))).toEqual(filled(4, 0x05));
  });
});
