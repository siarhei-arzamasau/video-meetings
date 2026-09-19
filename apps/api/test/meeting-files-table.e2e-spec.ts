import { useApiSuite } from './utils/api-suite';
import { EMAIL, MEETINGS_URL, PASSWORD, REGISTER_URL } from './utils/fixtures';
import { accessTokenOf } from './utils/http';
import { countMeetingFiles, insertMeetingFileRow } from './utils/meeting-files-table';
import { findUserRow, truncateUsers } from './utils/users-table';

/**
 * Pins the table the meeting-files specs read over raw SQL, and that the shared cleanup
 * reaches it. Everything else about the table is asserted by the route specs.
 */
describe('meeting_files table', () => {
  const suite = useApiSuite();

  it('starts empty on a truncated database', async () => {
    await expect(countMeetingFiles(suite.prisma())).resolves.toBe(0);
  });

  it('is emptied by truncateUsers, so no spec needs a cleanup of its own', async () => {
    const response = await suite.post(REGISTER_URL, { email: EMAIL, password: PASSWORD });
    const token = accessTokenOf(response);
    const user = await findUserRow(suite.prisma(), EMAIL);
    const meeting = await suite
      .post(MEETINGS_URL, {
        title: 'Files',
        scheduledAt: new Date().toISOString(),
        participantIds: [],
      })
      .set('Authorization', `Bearer ${token}`)
      .expect(201);
    const { id: meetingId } = meeting.body as { id: string };

    await insertMeetingFileRow(suite.prisma(), { meeting_id: meetingId, uploader_id: user.id });
    await expect(countMeetingFiles(suite.prisma())).resolves.toBe(1);

    await truncateUsers(suite.prisma());

    await expect(countMeetingFiles(suite.prisma())).resolves.toBe(0);
  });
});
