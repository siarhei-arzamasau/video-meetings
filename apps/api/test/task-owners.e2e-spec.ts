import { TaskLimitReachedError, TaskService } from '../src/modules/tasks/services/task.service';
import { MAX_TASKS_PER_OWNER } from '../src/modules/tasks/task.constants';
import { useApiSuite } from './utils/api-suite';
import { EMAIL, OTHER_EMAIL } from './utils/fixtures';
import { createMeeting, registerUser } from './utils/meeting-files-suite';

const TITLE = 'Call Bob about the venue';
const DONE = 'DONE';
const OPEN = 'OPEN';

/**
 * Whose task is whose, against the database: what an upsert conflicts with, how many an
 * owner may have, and what a reader is shown — their own tasks and the ones nobody owns.
 * The unique index is `NULLS NOT DISTINCT`, which the migration writes by hand and no
 * stubbed client can show.
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

  it('finds a reader their own tasks and the ones nobody owns, and nobody another user’s', async () => {
    const { host, participant, sourceMeetingId } = await members();
    const ofHost = await tasks().upsert({ title: TITLE, sourceMeetingId, ownerId: host.id });
    const ofNobody = await tasks().upsert({ title: TITLE, sourceMeetingId });
    const idsFound = async (readerId: string | null): Promise<string[]> =>
      (await tasks().search('Call Bob', sourceMeetingId, readerId)).map(({ id }) => id).toSorted();

    await expect(idsFound(host.id)).resolves.toEqual([ofHost.id, ofNobody.id].toSorted());
    await expect(idsFound(participant.id)).resolves.toEqual([ofNobody.id]);
    // A reader who is no user, as a digest's generation is: no user's task at all.
    await expect(idsFound(null)).resolves.toEqual([ofNobody.id]);
  });

  it('lists a reader their open tasks and the ones nobody owns, and not another user’s', async () => {
    const { host, participant, sourceMeetingId } = await members();
    const ofHost = await tasks().upsert({ title: TITLE, sourceMeetingId, ownerId: host.id });
    await tasks().upsert({ title: 'Print the badges', sourceMeetingId, ownerId: participant.id });
    const ofNobody = await tasks().upsert({ title: 'Book the venue', sourceMeetingId });

    const open = await tasks().open(sourceMeetingId, host.id);

    expect(open.map(({ id }) => id).toSorted()).toEqual([ofHost.id, ofNobody.id].toSorted());
  });

  it('writes no task past the most an owner may have, and still updates the ones they have', async () => {
    const { host, participant, sourceMeetingId } = await members();
    await suite.prisma().$executeRaw`
      INSERT INTO "tasks" (id, title, source_meeting_id, owner_id, updated_at)
      SELECT gen_random_uuid(), 'Task ' || n, ${sourceMeetingId}::uuid, ${host.id}::uuid, now()
      FROM generate_series(1, ${MAX_TASKS_PER_OWNER}) AS n
    `;

    await expect(
      tasks().upsert({ title: 'One too many', sourceMeetingId, ownerId: host.id }),
    ).rejects.toBeInstanceOf(TaskLimitReachedError);
    await expect(
      tasks().upsert({ title: 'Task 1', sourceMeetingId, ownerId: host.id, status: DONE }),
    ).resolves.toMatchObject({ title: 'Task 1', status: DONE });
    // The limit is each owner's: the host's being full is nobody else's.
    await expect(
      tasks().upsert({ title: 'One too many', sourceMeetingId, ownerId: participant.id }),
    ).resolves.toMatchObject({ ownerId: participant.id });
    await expect(tasks().upsert({ title: 'One too many', sourceMeetingId })).resolves.toMatchObject(
      { ownerId: null },
    );
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
