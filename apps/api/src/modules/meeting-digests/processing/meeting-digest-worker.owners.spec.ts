import { Logger } from '@nestjs/common';

import { FindMeetingMemberIdsQuery } from '../../meetings/queries/find-meeting-member-ids.query';
import { FindUsersByIdsQuery } from '../../user/queries/find-users-by-ids.query';
import { DIGEST_MEETING_ID, FIRST_RECORDING_ID } from '../services/meeting-digest-record.fixture';
import type { MeetingDigestWorker } from './meeting-digest-worker';
import {
  GENERATED,
  HELD,
  MEMBERS,
  OWNER_LINKS,
  buildDigestWorker,
  digestWorkerDoubles,
  resetDigestWorkerDoubles,
} from './meeting-digest-worker.fixture';

/**
 * Whose an action item is: the worker asks who is in the meeting once it holds an answer,
 * and stores beside each spoken name the member it identifies. What identifies a member is
 * `meeting-digest-owner.spec.ts`'s; this is that the question is asked, when, and of whom.
 */
describe('MeetingDigestWorker: the owners an answer names', () => {
  const doubles = digestWorkerDoubles();
  const { complete, fail, generate, transcribed, memberIds, memberNames } = doubles;
  let worker: MeetingDigestWorker;
  let errors: jest.SpyInstance;

  /** The links the stored answer was written with. */
  const storedLinks = (): Array<[string, string]> => {
    const [, content] = complete.mock.calls[0] as [unknown, { ownerLinks: Map<string, string> }];

    return [...content.ownerLinks];
  };

  beforeAll(() => {
    for (const level of ['log', 'warn'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
    errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterAll(() => jest.restoreAllMocks());

  beforeEach(async () => {
    errors.mockClear();
    resetDigestWorkerDoubles(doubles);
    ({ worker } = await buildDigestWorker(doubles));
  });

  it('stores each owner with the one member of the meeting the name identifies', async () => {
    await worker.drain();

    expect(memberIds).toHaveBeenCalledWith(new FindMeetingMemberIdsQuery(DIGEST_MEETING_ID));
    expect(memberNames).toHaveBeenCalledWith(new FindUsersByIdsQuery(MEMBERS.map(({ id }) => id)));
    expect(storedLinks()).toEqual([...OWNER_LINKS]);
  });

  it('reads the members only after Claude has answered: no name is part of what is sent', async () => {
    const order: string[] = [];
    generate.mockImplementation(async () => {
      order.push('answered');

      return GENERATED;
    });
    memberIds.mockImplementation(async () => {
      order.push('members read');

      return MEMBERS.map(({ id }) => id);
    });

    await worker.drain();

    expect(order).toEqual(['answered', 'members read']);
    expect(JSON.stringify(generate.mock.calls)).not.toMatch(/Hopper|Lovelace/);
  });

  it('links a name two members share to neither, and still stores the answer', async () => {
    memberNames.mockResolvedValue([...MEMBERS, { id: 'another', displayName: 'Grace Kelly' }]);

    await worker.drain();

    expect(storedLinks()).toEqual([]);
    expect(fail).not.toHaveBeenCalled();
  });

  it('stores the answer with every owner a name as spoken when the members cannot be read', async () => {
    memberNames.mockRejectedValue(new Error('connection terminated unexpectedly'));

    await worker.drain();

    // Not a failed digest: the answer was paid for, and a name as spoken is a whole answer.
    expect(complete).toHaveBeenCalledWith(HELD, expect.objectContaining({ ownerLinks: new Map() }));
    expect(fail).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining('its members could not be read'),
      expect.stringContaining('connection terminated unexpectedly'),
    );
  });

  it('asks about no member for an answer that names nobody, or one that is discarded', async () => {
    generate.mockResolvedValue({
      ...GENERATED,
      answer: { ...GENERATED.answer, actionItems: [{ description: 'Send the release notes.' }] },
    });

    await worker.drain();

    expect(complete).toHaveBeenCalledTimes(1);
    expect(storedLinks()).toEqual([]);
    expect(memberIds).not.toHaveBeenCalled();

    // A recording deleted while Claude wrote: the answer is handed back, its owners unread.
    resetDigestWorkerDoubles(doubles);
    transcribed.mockResolvedValue([{ id: FIRST_RECORDING_ID, uploaderId: MEMBERS[0]?.id }]);
    await worker.drain();

    expect(complete).not.toHaveBeenCalled();
    expect(memberIds).not.toHaveBeenCalled();
    expect(memberNames).not.toHaveBeenCalled();
  });
});
