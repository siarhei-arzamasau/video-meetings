import type { Prisma } from '../../../generated/prisma/client';
import {
  MAX_DIGEST_ITEMS,
  MAX_DIGEST_ITEM_LENGTH,
  MAX_DIGEST_SUMMARY_LENGTH,
} from '../meeting-digest.constants';
import { readMeetingDigestRevision, reviseContent } from './meeting-digest-revision';

const MEETING_ID = '44444444-4444-4444-8444-444444444444';
const DIGEST_ID = '66666666-6666-4666-8666-666666666666';
const REVISION = {
  summary: 'The launch moves to May.',
  decisions: ['Launch in May.', 'Hire two.'],
};

describe('readMeetingDigestRevision', () => {
  it('answers with the revision, every text trimmed', () => {
    expect(
      readMeetingDigestRevision({ summary: '  Moved to May. ', decisions: [' Launch in May.\n'] }),
    ).toEqual({ revision: { summary: 'Moved to May.', decisions: ['Launch in May.'] } });
  });

  it('accepts a revision that leaves the meeting with no decision', () => {
    expect(readMeetingDigestRevision({ summary: 'Nothing was decided.', decisions: [] })).toEqual({
      revision: { summary: 'Nothing was decided.', decisions: [] },
    });
  });

  it.each([
    ['a blank summary', { summary: '   ', decisions: [] }],
    [
      'a summary past its bound',
      { summary: 'a'.repeat(MAX_DIGEST_SUMMARY_LENGTH + 1), decisions: [] },
    ],
    ['a blank decision', { summary: 'Fine.', decisions: ['Launch in May.', ' '] }],
    [
      'a decision past its bound',
      { summary: 'Fine.', decisions: ['a'.repeat(MAX_DIGEST_ITEM_LENGTH + 1)] },
    ],
    [
      'more decisions than a digest holds',
      { summary: 'Fine.', decisions: Array(MAX_DIGEST_ITEMS + 1).fill('One.') },
    ],
  ])('refuses %s, naming the problem and quoting nothing', (_case, revision) => {
    const reading = readMeetingDigestRevision(revision);

    expect(reading).toEqual({ problem: expect.any(String) });
    expect(JSON.stringify(reading)).not.toContain('aaaa');
  });
});

/**
 * What a stubbed client can show: what each statement is asked, and in what order. That the
 * first of them locks the row against a generation is PostgreSQL's, and what the tables
 * hold afterwards is `test/meeting-digest-revise.e2e-spec.ts`'s.
 */
describe('reviseContent', () => {
  const calls: string[] = [];
  const updateManyAndReturn = jest.fn();
  const deleteMany = jest.fn();
  const createMany = jest.fn();
  const tx = {
    meetingDigest: { updateManyAndReturn },
    meetingDigestDecision: { deleteMany, createMany },
  } as unknown as Prisma.TransactionClient;

  beforeEach(() => {
    calls.length = 0;
    updateManyAndReturn.mockReset().mockImplementation(() => {
      calls.push('update');

      return Promise.resolve([{ id: DIGEST_ID }]);
    });
    deleteMany.mockReset().mockImplementation(() => {
      calls.push('delete');

      return Promise.resolve({ count: 1 });
    });
    createMany.mockReset().mockImplementation(() => {
      calls.push('create');

      return Promise.resolve({ count: 2 });
    });
  });

  it('writes the summary to a digest that has content, and moves its version', async () => {
    await expect(reviseContent(tx, MEETING_ID, REVISION)).resolves.toBe(true);

    expect(updateManyAndReturn).toHaveBeenCalledWith({
      where: { meetingId: MEETING_ID, summary: { not: null } },
      data: { summary: REVISION.summary, version: { increment: 1 } },
      select: { id: true },
    });
  });

  it('puts the decisions in place of the stored ones, in the order given', async () => {
    await reviseContent(tx, MEETING_ID, REVISION);

    expect(deleteMany).toHaveBeenCalledWith({ where: { digestId: DIGEST_ID } });
    expect(createMany).toHaveBeenCalledWith({
      data: [
        { digestId: DIGEST_ID, position: 0, description: 'Launch in May.' },
        { digestId: DIGEST_ID, position: 1, description: 'Hire two.' },
      ],
    });
  });

  it('updates the row before it touches a decision, which is what locks it', async () => {
    await reviseContent(tx, MEETING_ID, REVISION);

    expect(calls).toEqual(['update', 'delete', 'create']);
  });

  it('writes nothing more, and says so, for a meeting with no content to revise', async () => {
    updateManyAndReturn.mockResolvedValue([]);

    await expect(reviseContent(tx, MEETING_ID, REVISION)).resolves.toBe(false);

    expect(deleteMany).not.toHaveBeenCalled();
    expect(createMany).not.toHaveBeenCalled();
  });
});
