import { useApiSuite } from './utils/api-suite';
import { EMAIL } from './utils/fixtures';
import {
  countMeetingFileUploads,
  findMeetingFileUploadRow,
  insertMeetingFileUploadRow,
  setMeetingFileUploadState,
} from './utils/meeting-file-uploads-table';
import { createMeeting, registerUser } from './utils/meeting-files-suite';
import { truncateUsers } from './utils/users-table';

/**
 * Pins the table the chunked upload specs read over raw SQL, and that the shared cleanup
 * reaches it. Everything else about the table is asserted by the route specs.
 */
describe('meeting_file_uploads table', () => {
  const suite = useApiSuite();

  it('starts empty on a truncated database', async () => {
    await expect(countMeetingFileUploads(suite.prisma())).resolves.toBe(0);
  });

  it('stores a session with its chunk plan and no received chunks', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);

    const id = await insertMeetingFileUploadRow(suite.prisma(), {
      meeting_id: meeting.id,
      uploader_id: host.id,
      name: 'recording.mp4',
      size: 20,
      chunk_size: 8,
      chunk_count: 3,
    });

    await expect(findMeetingFileUploadRow(suite.prisma(), id)).resolves.toMatchObject({
      meeting_id: meeting.id,
      uploader_id: host.id,
      name: 'recording.mp4',
      size: 20,
      chunk_size: 8,
      chunk_count: 3,
      received_chunks: [],
      attempts: 0,
      leased_until: null,
      purged_at: null,
    });
  });

  it('round-trips the received chunk set and the expiry the worker reads', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const expiredAt = new Date(Date.now() - 1_000);

    const id = await insertMeetingFileUploadRow(suite.prisma(), {
      meeting_id: meeting.id,
      uploader_id: host.id,
    });
    await setMeetingFileUploadState(suite.prisma(), id, {
      received_chunks: [0, 2, 5],
      expires_at: expiredAt,
    });

    const row = await findMeetingFileUploadRow(suite.prisma(), id);
    expect(row.received_chunks).toEqual([0, 2, 5]);
    expect(Date.parse(row.expires_at)).toBe(expiredAt.getTime());
  });

  it('is emptied by truncateUsers, so no spec needs a cleanup of its own', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);

    await insertMeetingFileUploadRow(suite.prisma(), {
      meeting_id: meeting.id,
      uploader_id: host.id,
    });
    await expect(countMeetingFileUploads(suite.prisma())).resolves.toBe(1);

    await truncateUsers(suite.prisma());

    await expect(countMeetingFileUploads(suite.prisma())).resolves.toBe(0);
  });
});
