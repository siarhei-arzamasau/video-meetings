import type { Logger } from '@nestjs/common';
import type { QueryBus } from '@nestjs/cqrs';

import { FindMeetingMemberIdsQuery } from '../../meetings/queries/find-meeting-member-ids.query';
import { FindUsersByIdsQuery } from '../../user/queries/find-users-by-ids.query';
import type { MeetingDigestAnswer } from '../services/meeting-digest-answer';
import { DIGEST_MEETING_ID } from '../services/meeting-digest-record.fixture';
import { membersOf, ownerLinksOf } from './meeting-digest-owner-links';

const HOST_ID = '11111111-1111-4111-8111-111111111111';
const GRACE_ID = '22222222-2222-4222-8222-222222222222';

const answerNaming = (...ownerNames: Array<string | undefined>): MeetingDigestAnswer => ({
  summary: 'The team agreed to ship on Friday.',
  actionItems: ownerNames.map((ownerName) =>
    ownerName === undefined
      ? { description: 'Book the room.' }
      : { description: 'Send.', ownerName },
  ),
  decisions: [],
});

describe('the members an answer’s owners are matched against', () => {
  const memberIds = jest.fn();
  const names = jest.fn();
  const error = jest.fn();
  const execute = jest.fn((query: unknown) =>
    query instanceof FindMeetingMemberIdsQuery ? memberIds(query) : names(query),
  );
  const queryBus = { execute } as unknown as QueryBus;
  const logger = { error } as unknown as Logger;

  beforeEach(() => {
    execute.mockClear();
    error.mockReset();
    memberIds.mockReset().mockResolvedValue([HOST_ID, GRACE_ID]);
    names.mockReset().mockResolvedValue([
      { id: HOST_ID, displayName: 'Ada Lovelace' },
      { id: GRACE_ID, displayName: 'Grace Hopper' },
    ]);
  });

  describe('membersOf', () => {
    it('asks meetings who is in the meeting, and user what each of them is called', async () => {
      await expect(membersOf(queryBus, DIGEST_MEETING_ID)).resolves.toEqual([
        { id: HOST_ID, displayName: 'Ada Lovelace' },
        { id: GRACE_ID, displayName: 'Grace Hopper' },
      ]);

      expect(execute.mock.calls).toEqual([
        [new FindMeetingMemberIdsQuery(DIGEST_MEETING_ID)],
        [new FindUsersByIdsQuery([HOST_ID, GRACE_ID])],
      ]);
    });

    it('answers nobody for a meeting that is gone, and asks for no names', async () => {
      memberIds.mockResolvedValue(null);

      await expect(membersOf(queryBus, DIGEST_MEETING_ID)).resolves.toEqual([]);
      expect(names).not.toHaveBeenCalled();
    });
  });

  describe('ownerLinksOf', () => {
    const linksOf = async (answer: MeetingDigestAnswer): Promise<Array<[string, string]>> => [
      ...(await ownerLinksOf(queryBus, logger, DIGEST_MEETING_ID, answer)),
    ];

    it('links each name that identifies one member of the meeting to that member', async () => {
      await expect(linksOf(answerNaming('Grace', 'Linus', undefined))).resolves.toEqual([
        ['Grace', GRACE_ID],
      ]);
    });

    it('asks nothing for an answer that names nobody', async () => {
      await expect(linksOf(answerNaming(undefined, undefined))).resolves.toEqual([]);
      await expect(linksOf(answerNaming())).resolves.toEqual([]);

      expect(execute).not.toHaveBeenCalled();
    });

    it('links nobody in a meeting that is gone', async () => {
      memberIds.mockResolvedValue(null);

      await expect(linksOf(answerNaming('Grace'))).resolves.toEqual([]);
    });

    it.each([
      ['who is in the meeting', memberIds],
      ['what its members are called', names],
    ])('links nobody, and says why in the log, when %s cannot be read', async (_what, read) => {
      read.mockRejectedValue(new Error('connection terminated unexpectedly'));

      // Resolved, not rejected: the answer was paid for and is stored with names as spoken.
      await expect(linksOf(answerNaming('Grace'))).resolves.toEqual([]);

      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining(`Digest of meeting ${DIGEST_MEETING_ID}: its members could not`),
        expect.stringContaining('connection terminated unexpectedly'),
      );
    });
  });
});
