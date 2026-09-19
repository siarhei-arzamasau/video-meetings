import fs from 'node:fs';
import path from 'node:path';

import type { MeetingFile } from '@repo/shared';

import { useApiSuite } from './utils/api-suite';
import {
  EMAIL,
  OTHER_EMAIL,
  THIRD_EMAIL,
  meetingFileContentUrl,
  meetingFileUrl,
  meetingFilesDir,
  meetingFilesUrl,
} from './utils/fixtures';
import { messageOf } from './utils/http';
import { findMeetingFileRow } from './utils/meeting-files-table';
import { createMeeting, registerUser } from './utils/meeting-files-suite';

const FIXTURES = path.join(__dirname, 'fixtures');
const fixture = (name: string): string => path.join(FIXTURES, name);

describe('DELETE /api/meetings/:id/files/:fileId', () => {
  const suite = useApiSuite();

  const upload = async (token: string, meetingId: string): Promise<MeetingFile> => {
    const response = await suite
      .postFile(meetingFilesUrl(meetingId), token, fixture('sample.pdf'))
      .expect(201);

    return response.body as MeetingFile;
  };

  const remove = (token: string, meetingId: string, fileId: string) =>
    suite.delete(meetingFileUrl(meetingId, fileId)).set('Authorization', `Bearer ${token}`);

  const listIds = async (token: string, meetingId: string): Promise<string[]> => {
    const response = await suite
      .get(meetingFilesUrl(meetingId))
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    return (response.body as MeetingFile[]).map(({ id }) => id);
  };

  it("soft-deletes the uploader's own file: gone from the list and the download, bytes still on disk", async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const file = await upload(host.token, meeting.id);
    const before = Date.now();

    const response = await remove(host.token, meeting.id, file.id).expect(204);

    expect(response.body).toEqual({});
    await expect(listIds(host.token, meeting.id)).resolves.toEqual([]);
    await suite
      .get(meetingFileContentUrl(meeting.id, file.id))
      .set('Authorization', `Bearer ${host.token}`)
      .expect(404);

    const row = await findMeetingFileRow(suite.prisma(), file.id);
    expect(row.status).toBe('deleted');
    expect(row.deleted_at).not.toBeNull();
    expect(Date.parse(row.deleted_at ?? '')).toBeGreaterThanOrEqual(before - 1_000);
    expect(row.purged_at).toBeNull();
    expect(row.leased_until).toBeNull();
    // Purging is the worker's job, so a storage hiccup cannot leave a record pointing at
    // bytes that are still there. The delete itself touches no file.
    expect(fs.existsSync(path.join(meetingFilesDir(), meeting.id, file.id))).toBe(true);
  });

  it("lets the host delete a participant's file", async () => {
    const host = await registerUser(suite, EMAIL);
    const participant = await registerUser(suite, OTHER_EMAIL);
    const meeting = await createMeeting(suite, host, [participant.id]);
    const file = await upload(participant.token, meeting.id);

    await remove(host.token, meeting.id, file.id).expect(204);

    await expect(findMeetingFileRow(suite.prisma(), file.id)).resolves.toMatchObject({
      status: 'deleted',
    });
  });

  it('answers 404 File not found to another participant, changing nothing', async () => {
    const host = await registerUser(suite, EMAIL);
    const uploader = await registerUser(suite, OTHER_EMAIL);
    const other = await registerUser(suite, THIRD_EMAIL);
    const meeting = await createMeeting(suite, host, [uploader.id, other.id]);
    const file = await upload(uploader.token, meeting.id);
    const snapshot = await findMeetingFileRow(suite.prisma(), file.id);

    const response = await remove(other.token, meeting.id, file.id).expect(404);

    // 404, never 403: a participant who may not delete it learns nothing they did not have.
    expect(messageOf(response)).toBe('File not found');
    await expect(findMeetingFileRow(suite.prisma(), file.id)).resolves.toEqual(snapshot);
    await expect(listIds(other.token, meeting.id)).resolves.toEqual([file.id]);
  });

  it('answers 404 Meeting not found to a stranger', async () => {
    const host = await registerUser(suite, EMAIL);
    await registerUser(suite, OTHER_EMAIL);
    const stranger = await registerUser(suite, THIRD_EMAIL);
    const meeting = await createMeeting(suite, host);
    const file = await upload(host.token, meeting.id);

    const response = await remove(stranger.token, meeting.id, file.id).expect(404);

    expect(messageOf(response)).toBe('Meeting not found');
    await expect(findMeetingFileRow(suite.prisma(), file.id)).resolves.toMatchObject({
      status: 'uploaded',
    });
  });

  it('answers 404 when deleting twice', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const file = await upload(host.token, meeting.id);

    await remove(host.token, meeting.id, file.id).expect(204);
    const response = await remove(host.token, meeting.id, file.id).expect(404);

    expect(messageOf(response)).toBe('File not found');
  });

  it('answers 404 for a file id that belongs to another meeting', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const other = await createMeeting(suite, host, [], 'Other');
    const file = await upload(host.token, other.id);

    const response = await remove(host.token, meeting.id, file.id).expect(404);

    expect(messageOf(response)).toBe('File not found');
    await expect(findMeetingFileRow(suite.prisma(), file.id)).resolves.toMatchObject({
      status: 'uploaded',
    });
  });

  it('answers 401 without a token', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const file = await upload(host.token, meeting.id);

    await suite.delete(meetingFileUrl(meeting.id, file.id)).expect(401);
  });

  it('rejects a file id that is not a uuid with 400', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);

    await remove(host.token, meeting.id, 'file-1').expect(400);
  });
});
