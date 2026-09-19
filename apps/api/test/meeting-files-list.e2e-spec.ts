import { randomUUID } from 'node:crypto';

import type { MeetingFile } from '@repo/shared';

import { useApiSuite } from './utils/api-suite';
import { EMAIL, OTHER_EMAIL, THIRD_EMAIL, meetingFilesUrl } from './utils/fixtures';
import { messageOf } from './utils/http';
import { insertMeetingFileRow } from './utils/meeting-files-table';
import { createMeeting, registerUser } from './utils/meeting-files-suite';

describe('GET /api/meetings/:id/files', () => {
  const suite = useApiSuite();

  const listFiles = (token: string, meetingId: string) =>
    suite.get(meetingFilesUrl(meetingId)).set('Authorization', `Bearer ${token}`);

  it('returns an empty list to the host of a meeting with no files', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);

    const response = await listFiles(host.token, meeting.id).expect(200);

    expect(response.body).toEqual([]);
  });

  it('returns an empty list to a participant', async () => {
    const host = await registerUser(suite, EMAIL);
    const participant = await registerUser(suite, OTHER_EMAIL);
    const meeting = await createMeeting(suite, host, [participant.id]);

    const response = await listFiles(participant.token, meeting.id).expect(200);

    expect(response.body).toEqual([]);
  });

  it('answers 404 to a signed-in user who is neither host nor participant', async () => {
    const host = await registerUser(suite, EMAIL);
    await registerUser(suite, OTHER_EMAIL);
    const stranger = await registerUser(suite, THIRD_EMAIL);
    const meeting = await createMeeting(suite, host);

    const response = await listFiles(stranger.token, meeting.id).expect(404);

    // The same message as for a meeting that does not exist, so the route cannot confirm that
    // someone else's meeting is at that id.
    expect(messageOf(response)).toBe('Meeting not found');
  });

  it('answers 404 with the same message for a meeting that does not exist', async () => {
    const user = await registerUser(suite, EMAIL);

    const response = await listFiles(user.token, randomUUID()).expect(404);

    expect(messageOf(response)).toBe('Meeting not found');
  });

  it('answers 401 without a token', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);

    await suite.get(meetingFilesUrl(meeting.id)).expect(401);
  });

  it('rejects a meeting id that is not a uuid with 400', async () => {
    const user = await registerUser(suite, EMAIL);

    await listFiles(user.token, 'meeting-1').expect(400);
  });

  it('orders files newest first, breaking ties on id descending', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const createdAt = new Date('2026-09-01T10:00:00.000Z');
    const older = await insertMeetingFileRow(suite.prisma(), {
      meeting_id: meeting.id,
      uploader_id: host.id,
      name: 'older.txt',
      created_at: new Date('2026-08-01T10:00:00.000Z'),
    });
    const tiedA = await insertMeetingFileRow(suite.prisma(), {
      meeting_id: meeting.id,
      uploader_id: host.id,
      name: 'tied-a.txt',
      created_at: createdAt,
    });
    const tiedB = await insertMeetingFileRow(suite.prisma(), {
      meeting_id: meeting.id,
      uploader_id: host.id,
      name: 'tied-b.txt',
      created_at: createdAt,
    });

    const response = await listFiles(host.token, meeting.id).expect(200);
    const ids = (response.body as MeetingFile[]).map(({ id }) => id);

    // Insertion order says nothing: the tie-break is on id, so derive it from the ids.
    const [tiedFirst, tiedSecond] = [tiedA, tiedB].toSorted((a, b) => (a < b ? 1 : -1));
    expect(ids).toEqual([tiedFirst, tiedSecond, older]);
  });

  it('omits deleted files', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const kept = await insertMeetingFileRow(suite.prisma(), {
      meeting_id: meeting.id,
      uploader_id: host.id,
      status: 'ready',
    });
    await insertMeetingFileRow(suite.prisma(), {
      meeting_id: meeting.id,
      uploader_id: host.id,
      status: 'deleted',
      deleted_at: new Date(),
    });

    const response = await listFiles(host.token, meeting.id).expect(200);

    expect((response.body as MeetingFile[]).map(({ id }) => id)).toEqual([kept]);
  });

  it('only lists the files of the meeting asked for', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const other = await createMeeting(suite, host, [], 'Other');
    await insertMeetingFileRow(suite.prisma(), { meeting_id: other.id, uploader_id: host.id });

    const response = await listFiles(host.token, meeting.id).expect(200);

    expect(response.body).toEqual([]);
  });

  it('renders the wire shape: failureReason only when failed, thumbnailPath only with a thumbnail, never the storage columns', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const failed = await insertMeetingFileRow(suite.prisma(), {
      meeting_id: meeting.id,
      uploader_id: host.id,
      name: 'broken.png',
      content_type: 'image/png',
      size: 12,
      status: 'failed',
      failure_reason: 'The image could not be read',
      attempts: 1,
      created_at: new Date('2026-09-01T10:00:00.000Z'),
    });
    const ready = await insertMeetingFileRow(suite.prisma(), {
      meeting_id: meeting.id,
      uploader_id: host.id,
      name: 'photo.png',
      content_type: 'image/png',
      size: 34,
      status: 'ready',
      checksum: 'abc',
      thumbnail_key: `${meeting.id}/thumb.thumb.webp`,
      processed_at: new Date('2026-09-02T10:00:01.000Z'),
      created_at: new Date('2026-09-02T10:00:00.000Z'),
    });
    const uploaded = await insertMeetingFileRow(suite.prisma(), {
      meeting_id: meeting.id,
      uploader_id: host.id,
      name: 'notes.txt',
      size: 5,
      created_at: new Date('2026-09-03T10:00:00.000Z'),
    });

    const response = await listFiles(host.token, meeting.id).expect(200);

    expect(response.body).toEqual([
      {
        id: uploaded,
        meetingId: meeting.id,
        uploaderId: host.id,
        name: 'notes.txt',
        contentType: 'text/plain',
        size: 5,
        status: 'uploaded',
        createdAt: '2026-09-03T10:00:00.000Z',
      },
      {
        id: ready,
        meetingId: meeting.id,
        uploaderId: host.id,
        name: 'photo.png',
        contentType: 'image/png',
        size: 34,
        status: 'ready',
        thumbnailPath: `/meetings/${meeting.id}/files/${ready}/thumbnail`,
        createdAt: '2026-09-02T10:00:00.000Z',
        processedAt: '2026-09-02T10:00:01.000Z',
      },
      {
        id: failed,
        meetingId: meeting.id,
        uploaderId: host.id,
        name: 'broken.png',
        contentType: 'image/png',
        size: 12,
        status: 'failed',
        failureReason: 'The image could not be read',
        createdAt: '2026-09-01T10:00:00.000Z',
      },
    ]);
  });
});
