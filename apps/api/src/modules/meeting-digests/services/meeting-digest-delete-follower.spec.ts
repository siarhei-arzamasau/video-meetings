import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QueryBus } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';

import { FindTranscribedRecordingsQuery } from '../../meeting-files/queries/find-transcribed-recordings.query';
import { MeetingDigestAnnouncer } from './meeting-digest-announcer';
import { MeetingDigestDeleteFollower } from './meeting-digest-delete-follower';
import { DigestAfterDelete } from './meeting-digest-writes';
import { MeetingDigestRepository } from './meeting-digest.repository';

const MEETING_ID = '44444444-4444-4444-8444-444444444444';
const DELETED_ID = '55555555-5555-4555-8555-555555555555';
const REMAINING_ID = '55555555-5555-4555-8555-555555555556';
const UPLOADER_ID = '11111111-1111-4111-8111-111111111111';

const DELETED = { recordingDeleted: true, because: `file ${DELETED_ID} was deleted` };

describe('MeetingDigestDeleteFollower', () => {
  const findRevisionOf = jest.fn();
  const followDelete = jest.fn();
  const execute = jest.fn();
  const announce = jest.fn();
  let enabled: boolean;
  let follower: MeetingDigestDeleteFollower;

  beforeAll(() => {
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });

  afterAll(() => jest.restoreAllMocks());

  beforeEach(async () => {
    enabled = true;
    findRevisionOf.mockReset().mockResolvedValue(4);
    followDelete.mockReset().mockResolvedValue(DigestAfterDelete.REPLACING);
    execute.mockReset().mockResolvedValue([{ id: REMAINING_ID, uploaderId: UPLOADER_ID }]);
    announce.mockReset().mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      providers: [
        MeetingDigestDeleteFollower,
        { provide: MeetingDigestRepository, useValue: { findRevisionOf, followDelete } },
        { provide: MeetingDigestAnnouncer, useValue: { announce } },
        { provide: QueryBus, useValue: { execute } },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, fallback: unknown) =>
              key === 'MEETING_DIGEST_ENABLED' ? enabled : fallback,
          },
        },
      ],
    }).compile();

    follower = moduleRef.get(MeetingDigestDeleteFollower);
  });

  describe('follow', () => {
    it('decides from the recordings left, the setting, and what its caller knows of the delete', async () => {
      await expect(follower.follow(MEETING_ID, DELETED)).resolves.toBe(DigestAfterDelete.REPLACING);

      expect(execute).toHaveBeenCalledWith(new FindTranscribedRecordingsQuery(MEETING_ID));
      expect(followDelete).toHaveBeenCalledTimes(1);
      expect(followDelete).toHaveBeenCalledWith({
        meetingId: MEETING_ID,
        requestedRevision: 4,
        transcribedFileIds: [REMAINING_ID],
        replace: true,
        recordingDeleted: true,
      });
    });

    it('reads the revision before the recordings, writes after both, and announces last', async () => {
      const order: string[] = [];
      findRevisionOf.mockImplementation(async () => {
        order.push('revision');

        return 4;
      });
      execute.mockImplementation(async () => {
        order.push('recordings');

        return [];
      });
      followDelete.mockImplementation(async () => {
        order.push('write');

        return DigestAfterDelete.CLEARED;
      });
      announce.mockImplementation(async () => {
        order.push('announce');
      });

      await follower.follow(MEETING_ID, DELETED);

      expect(order).toEqual(['revision', 'recordings', 'write', 'announce']);
    });

    it('asks for no replacement while the digest is switched off, and still follows the delete', async () => {
      enabled = false;

      await follower.follow(MEETING_ID, DELETED);

      expect(followDelete).toHaveBeenCalledWith(expect.objectContaining({ replace: false }));
    });

    it('passes on that no recording was deleted', async () => {
      await follower.follow(MEETING_ID, { ...DELETED, recordingDeleted: false });

      expect(followDelete).toHaveBeenCalledWith(
        expect.objectContaining({ recordingDeleted: false }),
      );
    });

    it('stops at one read for a meeting that has no digest', async () => {
      findRevisionOf.mockResolvedValue(null);

      await expect(follower.follow(MEETING_ID, DELETED)).resolves.toBe(DigestAfterDelete.UNCHANGED);

      expect(execute).not.toHaveBeenCalled();
      expect(followDelete).not.toHaveBeenCalled();
      expect(announce).not.toHaveBeenCalled();
    });

    it.each([
      DigestAfterDelete.REPLACING,
      DigestAfterDelete.CLEARED,
      DigestAfterDelete.WITHDRAWN,
      DigestAfterDelete.CURRENT_AGAIN,
    ])('announces the digest once after a write: %s', async (outcome) => {
      followDelete.mockResolvedValue(outcome);

      await follower.follow(MEETING_ID, DELETED);

      expect(announce).toHaveBeenCalledTimes(1);
      expect(announce).toHaveBeenCalledWith(MEETING_ID);
    });

    it('announces nothing when the delete changed nothing about the digest', async () => {
      followDelete.mockResolvedValue(DigestAfterDelete.UNCHANGED);

      await follower.follow(MEETING_ID, DELETED);

      expect(announce).not.toHaveBeenCalled();
    });

    it('rejects when the write fails, having announced nothing: its caller logs', async () => {
      followDelete.mockRejectedValue(new Error('connection terminated'));

      await expect(follower.follow(MEETING_ID, DELETED)).rejects.toThrow('connection terminated');

      expect(announce).not.toHaveBeenCalled();
    });
  });

  describe('recheckStored', () => {
    it('does nothing more when every recording of the stored answer is still transcribed', async () => {
      await follower.recheckStored(MEETING_ID, [REMAINING_ID]);

      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith(new FindTranscribedRecordingsQuery(MEETING_ID));
      expect(findRevisionOf).not.toHaveBeenCalled();
      expect(followDelete).not.toHaveBeenCalled();
      expect(announce).not.toHaveBeenCalled();
    });

    it('follows the delete of a recording the stored answer was built from', async () => {
      // The delete was followed before the answer landed, and found nothing of it to remove.
      await follower.recheckStored(MEETING_ID, [REMAINING_ID, DELETED_ID]);

      expect(followDelete).toHaveBeenCalledTimes(1);
      expect(followDelete).toHaveBeenCalledWith({
        meetingId: MEETING_ID,
        requestedRevision: 4,
        transcribedFileIds: [REMAINING_ID],
        replace: true,
        // The out-of-date mark is the delete's own reaction's to move, not this look's.
        recordingDeleted: false,
      });
      expect(announce).toHaveBeenCalledTimes(1);
    });

    it('follows it when every recording of the answer has gone', async () => {
      execute.mockResolvedValue([]);
      followDelete.mockResolvedValue(DigestAfterDelete.CLEARED);

      await follower.recheckStored(MEETING_ID, [DELETED_ID]);

      expect(followDelete).toHaveBeenCalledWith(
        expect.objectContaining({ transcribedFileIds: [] }),
      );
    });

    it.each([
      [
        'the recordings cannot be read',
        (): void => void execute.mockRejectedValue(new Error('connection terminated')),
      ],
      [
        'the write fails',
        (): void => void followDelete.mockRejectedValue(new Error('connection terminated')),
      ],
    ])(
      'never rejects, and logs, when %s: the answer is stored and the read withholds it',
      async (_case, arrange) => {
        const logged = jest.spyOn(Logger.prototype, 'error');
        arrange();

        await expect(
          follower.recheckStored(MEETING_ID, [REMAINING_ID, DELETED_ID]),
        ).resolves.toBeUndefined();

        expect(announce).not.toHaveBeenCalled();
        expect(logged).toHaveBeenCalledWith(
          expect.stringContaining(`Digest of meeting ${MEETING_ID}`),
          expect.stringContaining('connection terminated'),
        );
      },
    );
  });
});
