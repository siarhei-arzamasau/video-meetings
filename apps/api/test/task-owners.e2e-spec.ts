import { TaskService } from '../src/modules/tasks/services/task.service';
import { useApiSuite } from './utils/api-suite';
import { EMAIL, OTHER_EMAIL } from './utils/fixtures';
import { createMeeting, registerUser } from './utils/meeting-files-suite';

const TITLE = 'Call Bob about the venue';
const DONE = 'DONE';
const OPEN = 'OPEN';

/**
 * Whose task is whose, against the database: what an upsert conflicts with, and what a
 * search and a list are narrowed to. The unique index is `NULLS NOT DISTINCT`, which the
 * migration writes by hand and no stubbed client can show.
 */
describe('tasks and their owners, against the database', () => {
  const suite = useApiSuite();
  const tasks = (): TaskService => suite.app().get(TaskService);
  const members = async () => {
    const host = await registerUser(suite, EMAIL);
    const participant = await registerUser(suite, OTHER_EMAIL);
    const meeting = await createMeeting(suite, host, [participant.id]);

    return { host, participant, sourceMeetingId: meeting.id };
  };

  it('keeps one title as a task of each owner, and one more that is nobody’s', async () => {
    const { host, participant, sourceMeetingId } = await members();

    const ofHost = await tasks().upsert({ title: TITLE, sourceMeetingId, ownerId: host.id });
    const ofParticipant = await tasks().upsert({
      title: TITLE,
      sourceMeetingId,
      ownerId: participant.id,
    });
    const ofNobody = await tasks().upsert({ title: TITLE, sourceMeetingId });

    expect(new Set([ofHost.id, ofParticipant.id, ofNobody.id]).size).toBe(3);
    expect([ofHost.ownerId, ofParticipant.ownerId, ofNobody.ownerId]).toEqual([
      host.id,
      participant.id,
      null,
    ]);
  });

  it("updates the owner's own task, and leaves everybody else's of the same title alone", async () => {
    const { host, participant, sourceMeetingId } = await members();
    const ofHost = await tasks().upsert({ title: TITLE, sourceMeetingId, ownerId: host.id });
    const ofNobody = await tasks().upsert({ title: TITLE, sourceMeetingId });

    const ofParticipant = await tasks().upsert({
      title: TITLE,
      sourceMeetingId,
      ownerId: participant.id,
      status: DONE,
    });
    const again = await tasks().upsert({ title: TITLE, sourceMeetingId, ownerId: participant.id });

    // The same task twice for its owner, and a status nobody else's task took on.
    expect(again).toMatchObject({ id: ofParticipant.id, status: DONE });
    await expect(tasks().get(ofHost.id)).resolves.toMatchObject({ status: OPEN });
    await expect(tasks().get(ofNobody.id)).resolves.toMatchObject({ status: OPEN });
  });

  it('searches one owner’s tasks, the tasks nobody owns, or everybody’s', async () => {
    const { host, participant, sourceMeetingId } = await members();
    const ofHost = await tasks().upsert({ title: TITLE, sourceMeetingId, ownerId: host.id });
    const ofNobody = await tasks().upsert({ title: TITLE, sourceMeetingId });
    const idsFound = async (ownerId?: string | null): Promise<string[]> =>
      (await tasks().search('Call Bob', sourceMeetingId, ownerId)).map(({ id }) => id);

    await expect(idsFound(host.id)).resolves.toEqual([ofHost.id]);
    await expect(idsFound(participant.id)).resolves.toEqual([]);
    await expect(idsFound(null)).resolves.toEqual([ofNobody.id]);
    await expect(idsFound()).resolves.toHaveLength(2);
  });

  it('lists the open tasks of one owner, and neither another owner’s nor nobody’s', async () => {
    const { host, participant, sourceMeetingId } = await members();
    const ofHost = await tasks().upsert({ title: TITLE, sourceMeetingId, ownerId: host.id });
    await tasks().upsert({ title: 'Print the badges', sourceMeetingId, ownerId: participant.id });
    await tasks().upsert({ title: 'Book the venue', sourceMeetingId });

    const open = await tasks().open(sourceMeetingId, host.id);

    expect(open.map(({ id }) => id)).toEqual([ofHost.id]);
  });

  it('refuses a task of an owner who does not exist', async () => {
    const { sourceMeetingId } = await members();

    await expect(
      tasks().upsert({
        title: TITLE,
        sourceMeetingId,
        ownerId: '99999999-9999-4999-8999-999999999999',
      }),
    ).rejects.toThrow(/tasks_owner_id_fkey/);
  });

  it('deletes a user’s tasks with their account, and nobody else’s', async () => {
    const { host, participant, sourceMeetingId } = await members();
    const ofHost = await tasks().upsert({ title: TITLE, sourceMeetingId, ownerId: host.id });
    const ofParticipant = await tasks().upsert({
      title: TITLE,
      sourceMeetingId,
      ownerId: participant.id,
    });

    await suite.prisma().user.delete({ where: { id: participant.id } });

    await expect(tasks().get(ofParticipant.id)).resolves.toBeNull();
    await expect(tasks().get(ofHost.id)).resolves.not.toBeNull();
  });
});
