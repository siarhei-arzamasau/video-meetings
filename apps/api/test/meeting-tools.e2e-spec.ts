import { EventBus } from '@nestjs/cqrs';

import { MeetingDigestChangedEvent } from '../src/modules/meeting-digests/events/meeting-digest-changed.event';
import { NO_OWNER_LINKS } from '../src/modules/meeting-digests/services/meeting-digest-owner';
import { MeetingTools } from '../src/modules/meeting-tools/meeting-tools';
import { useApiSuite } from './utils/api-suite';
import { heldBy, useDigestClaimsSuite } from './utils/digest-claims-suite';
import { OTHER_EMAIL } from './utils/fixtures';
import { createMeeting, registerUser } from './utils/meeting-files-suite';
import { FAILED, READY, findMeetingDigestContentRows } from './utils/meeting-digests-table';
import { TOOLKIT_OVERRIDE, answerOf, callTool } from './utils/tool-calls';
import type { ToolAnswer } from './utils/tool-calls';

const ANSWER = {
  summary: 'The launch moves to April.',
  actionItems: [{ description: 'Rewrite the emails.', ownerName: 'Alice Johnson' }],
  decisions: [{ description: 'Launch on the fifteenth of April.' }],
};

describe('the meeting tools, against the database', () => {
  const suite = useApiSuite({ overrides: [TOOLKIT_OVERRIDE] });
  const { claims, rowOf, claimed, recordingOf, newMeeting } = useDigestClaimsSuite(suite);

  /** Calls a tool of the server made for `meetingId`. */
  const callFor = async (meetingId: string, name: string, input: object): Promise<ToolAnswer> =>
    callTool(await suite.app().get(MeetingTools).createServer(meetingId), name, input);

  /** A meeting whose digest a generation completed from one recording; its id. */
  const meetingWithDigest = async (): Promise<string> => {
    const { meetingId, claim } = await claimed();

    await claims().complete(heldBy(claim), {
      ownerLinks: NO_OWNER_LINKS,
      answer: ANSWER,
      sourceFileIds: [await recordingOf(meetingId)],
    });

    return meetingId;
  };

  it('upserts a task and finds it again by a rewording of its title', async () => {
    const meetingId = await newMeeting();

    const created = await callFor(meetingId, 'upsert_task', {
      title: 'Rewrite the launch emails',
      sourceMeetingId: meetingId,
    });
    const found = await callFor(meetingId, 'find_tasks', { query: 'rewrite launch email' });

    const task = {
      id: expect.any(String),
      title: 'Rewrite the launch emails',
      status: 'OPEN',
      sourceMeetingId: meetingId,
    };
    expect(answerOf(created)).toEqual({ task });
    expect(answerOf(found)).toEqual({ tasks: [task] });
  });

  it('updates the status of the task a meeting already has, and makes no second one', async () => {
    const meetingId = await newMeeting();
    await callFor(meetingId, 'upsert_task', { title: 'Call Bob', sourceMeetingId: meetingId });

    await callFor(meetingId, 'upsert_task', {
      title: 'Call Bob',
      status: 'DONE',
      sourceMeetingId: meetingId,
    });

    expect(answerOf(await callFor(meetingId, 'find_tasks', { query: 'Call Bob' }))).toMatchObject({
      tasks: [{ title: 'Call Bob', status: 'DONE' }],
    });
  });

  it('reaches no meeting but the one its server was made for', async () => {
    const host = await registerUser(suite, OTHER_EMAIL);
    const [meetingId, otherMeetingId] = [await newMeeting(), (await createMeeting(suite, host)).id];
    await callFor(otherMeetingId, 'upsert_task', {
      title: 'Call Bob about the venue',
      sourceMeetingId: otherMeetingId,
    });

    const written = await callFor(meetingId, 'upsert_task', {
      title: 'Call Bob about the budget',
      sourceMeetingId: otherMeetingId,
    });
    const found = await callFor(meetingId, 'find_tasks', { query: 'Call Bob' });
    const revised = await callFor(meetingId, 'update_meeting', {
      meetingId: otherMeetingId,
      summary: 'Rewritten from another meeting.',
      decisions: [],
    });

    for (const answer of [written, revised]) {
      expect(answer.isError).toBe(true);
      expect(answer.content[0]?.text).toMatch(/one meeting/);
    }
    expect(answerOf(found)).toEqual({ tasks: [] });
    expect(
      answerOf(await callFor(otherMeetingId, 'find_tasks', { query: 'Call Bob' })),
    ).toMatchObject({ tasks: [{ title: 'Call Bob about the venue' }] });
  });

  it('answers a task of a meeting that is gone as an error, and stores nothing', async () => {
    const meetingId = '99999999-9999-4999-8999-999999999999';

    const answer = await callFor(meetingId, 'upsert_task', {
      title: 'Call Bob',
      sourceMeetingId: meetingId,
    });

    expect(answer).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'The task could not be saved. Check the meeting id.' }],
    });
    expect(answerOf(await callFor(meetingId, 'find_tasks', { query: 'Call Bob' }))).toEqual({
      tasks: [],
    });
  });

  it('puts a summary and decisions in place of the stored ones, and tells the open pages', async () => {
    const meetingId = await meetingWithDigest();
    const before = await rowOf(meetingId);
    const announced: MeetingDigestChangedEvent[] = [];
    const subscription = suite
      .app()
      .get(EventBus)
      .subscribe((event) => {
        if (event instanceof MeetingDigestChangedEvent) {
          announced.push(event);
        }
      });

    const answer = await callFor(meetingId, 'update_meeting', {
      meetingId,
      summary: ' The launch moves to May. ',
      decisions: ['Launch in May.', 'Hire two engineers.'],
    });
    subscription.unsubscribe();

    expect(answerOf(answer)).toEqual({ meetingId, updated: true });
    await expect(rowOf(meetingId)).resolves.toMatchObject({
      status: READY,
      summary: 'The launch moves to May.',
      generated_at: before?.generated_at,
      version: (before?.version ?? 0) + 1,
    });
    await expect(findMeetingDigestContentRows(suite.prisma(), meetingId)).resolves.toMatchObject({
      actionItems: [{ description: 'Rewrite the emails.', owner_name: 'Alice Johnson' }],
      decisions: ['Launch in May.', 'Hire two engineers.'],
      sources: [expect.any(String)],
    });
    expect(announced).toHaveLength(1);
    expect(announced[0]).toMatchObject({ meetingId, digest: { version: before!.version + 1 } });
  });

  it('revises the content a failed generation left in place, and leaves the failure', async () => {
    const meetingId = await meetingWithDigest();
    await suite.prisma().$executeRawUnsafe(
      `UPDATE "meeting_digests" SET status = 'FAILED', failure_reason = 'It failed.'
       WHERE meeting_id = $1::uuid`,
      meetingId,
    );

    await callFor(meetingId, 'update_meeting', { meetingId, summary: 'Revised.', decisions: [] });

    await expect(rowOf(meetingId)).resolves.toMatchObject({
      status: FAILED,
      failure_reason: 'It failed.',
      summary: 'Revised.',
    });
    await expect(findMeetingDigestContentRows(suite.prisma(), meetingId)).resolves.toMatchObject({
      decisions: [],
    });
  });

  it.each([
    ['has no digest row', newMeeting],
    [
      'has a digest that was asked for and never generated',
      async () => (await claimed()).meetingId,
    ],
  ])('writes nothing for a meeting that %s', async (_case, meetingOf) => {
    const meetingId = await meetingOf();
    const before = await rowOf(meetingId);

    const answer = await callFor(meetingId, 'update_meeting', {
      meetingId,
      summary: 'The launch moves to May.',
      decisions: ['Launch in May.'],
    });

    expect(answer.isError).toBe(true);
    expect(answer.content[0]?.text).toMatch(/no digest yet/);
    await expect(rowOf(meetingId)).resolves.toEqual(before);
  });
});
