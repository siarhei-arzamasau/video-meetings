import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { MeetingFile } from '@repo/shared';

import { MeetingFileChangedEvent } from '../../meeting-files/events/meeting-file-changed.event';
import { MeetingDigestDeleteFollower } from '../services/meeting-digest-delete-follower';
import { DigestAfterDelete } from '../services/meeting-digest-writes';
import { PendingDigestRequests } from '../services/pending-digest-requests';
import { WithdrawDigestWhenDeletedHandler } from './withdraw-digest-when-deleted.handler';

const MEETING_ID = '44444444-4444-4444-8444-444444444444';
const DELETED_ID = '55555555-5555-4555-8555-555555555555';
const UPLOADER_ID = '11111111-1111-4111-8111-111111111111';

const file = (overrides: Partial<MeetingFile>): MeetingFile => ({
  id: DELETED_ID,
  meetingId: MEETING_ID,
  uploaderId: UPLOADER_ID,
  name: 'standup.mp3',
  contentType: 'audio/mpeg',
  size: 1024,
  status: 'deleted',
  createdAt: '2026-10-08T09:00:00.000Z',
  ...overrides,
});

/** A delete announces the row as it read it, transcription status and all. */
const DELETED_RECORDING = file({ transcriptionStatus: 'transcribed' });

/**
 * The handler's own part: which events it follows, what it takes from one, and that its work
 * is registered and never escapes. What following a delete does is the follower's spec.
 */
describe('WithdrawDigestWhenDeletedHandler', () => {
  const follow = jest.fn();
  let pending: PendingDigestRequests;
  let handler: WithdrawDigestWhenDeletedHandler;

  const announced = async (deleted: MeetingFile): Promise<void> => {
    handler.handle(new MeetingFileChangedEvent(MEETING_ID, deleted));
    await pending.settled();
  };

  beforeEach(async () => {
    follow.mockReset().mockResolvedValue(DigestAfterDelete.REPLACING);

    const moduleRef = await Test.createTestingModule({
      providers: [
        WithdrawDigestWhenDeletedHandler,
        PendingDigestRequests,
        { provide: MeetingDigestDeleteFollower, useValue: { follow } },
      ],
    }).compile();

    handler = moduleRef.get(WithdrawDigestWhenDeletedHandler);
    pending = moduleRef.get(PendingDigestRequests);
  });

  it('makes the digest follow a deleted recording, and says which file for the log', async () => {
    await announced(DELETED_RECORDING);

    expect(follow).toHaveBeenCalledTimes(1);
    expect(follow).toHaveBeenCalledWith(MEETING_ID, {
      recordingDeleted: true,
      because: `file ${DELETED_ID} was deleted`,
    });
  });

  // The event carries the status the delete read, and a transcription can finish between
  // that read and the delete: "transcribing" here may be a recording that was transcribed,
  // and had made the digest out of date, by the time it was gone.
  it.each(['queued', 'transcribing', 'transcribed', 'failed'] as const)(
    'counts a recording as one that may have been transcribed, whatever its event says: %s',
    async (transcriptionStatus) => {
      await announced(file({ transcriptionStatus }));

      expect(follow).toHaveBeenCalledWith(
        MEETING_ID,
        expect.objectContaining({ recordingDeleted: true }),
      );
    },
  );

  it('says when the deleted file never had a transcription, and follows it all the same', async () => {
    // Which recordings a digest was built from is the digest's to know, not the event's.
    await announced(file({ contentType: 'application/pdf', name: 'deck.pdf' }));

    expect(follow).toHaveBeenCalledWith(
      MEETING_ID,
      expect.objectContaining({ recordingDeleted: false }),
    );
  });

  it.each([
    [
      'a recording that was transcribed',
      file({ status: 'ready', transcriptionStatus: 'transcribed' }),
    ],
    ['an upload not yet processed', file({ status: 'uploaded' })],
    ['a file that failed', file({ status: 'failed' })],
  ])('does nothing for %s: only a delete is followed', async (_case, changed) => {
    await announced(changed);

    expect(follow).not.toHaveBeenCalled();
  });

  it('has registered its work by the time it returns, so shutdown and drain wait for it', async () => {
    let followed = false;
    follow.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      followed = true;

      return DigestAfterDelete.CLEARED;
    });

    // Not awaited: the bus does not wait for a handler either.
    handler.handle(new MeetingFileChangedEvent(MEETING_ID, DELETED_RECORDING));
    expect(followed).toBe(false);

    await pending.settled();
    expect(followed).toBe(true);
  });

  it('logs a reaction that fails and lets nothing escape: the delete is not undone', async () => {
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    follow.mockRejectedValue(new Error('connection terminated'));

    expect(() =>
      handler.handle(new MeetingFileChangedEvent(MEETING_ID, DELETED_RECORDING)),
    ).not.toThrow();
    await expect(pending.settled()).resolves.toBeUndefined();

    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining(`Digest of meeting ${MEETING_ID}`),
      expect.stringContaining('connection terminated'),
    );
    logged.mockRestore();
  });
});
