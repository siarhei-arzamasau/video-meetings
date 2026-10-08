import { Logger } from '@nestjs/common';
import { EventBus } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';
import type { MeetingDigest } from '@repo/shared';

import { MeetingDigestChangedEvent } from '../events/meeting-digest-changed.event';
import { MeetingDigestAnnouncer } from './meeting-digest-announcer';
import { DIGEST_MEETING_ID } from './meeting-digest-record.fixture';
import { MeetingDigestsService } from './meeting-digests.service';

const DIGEST: MeetingDigest = { meetingId: DIGEST_MEETING_ID, version: 5, status: 'generating' };

describe('MeetingDigestAnnouncer', () => {
  const currentOf = jest.fn();
  const publish = jest.fn();
  let announcer: MeetingDigestAnnouncer;

  beforeEach(async () => {
    currentOf.mockReset().mockResolvedValue(DIGEST);
    publish.mockReset();

    const moduleRef = await Test.createTestingModule({
      providers: [
        MeetingDigestAnnouncer,
        { provide: MeetingDigestsService, useValue: { currentOf } },
        { provide: EventBus, useValue: { publish } },
      ],
    }).compile();

    announcer = moduleRef.get(MeetingDigestAnnouncer);
  });

  it('publishes the digest as the read answers it now, once, for its meeting', async () => {
    await announcer.announce(DIGEST_MEETING_ID);

    expect(currentOf).toHaveBeenCalledWith(DIGEST_MEETING_ID);
    expect(publish).toHaveBeenCalledTimes(1);
    const [event] = publish.mock.calls[0] as [MeetingDigestChangedEvent];
    expect(event).toBeInstanceOf(MeetingDigestChangedEvent);
    expect(event).toEqual(new MeetingDigestChangedEvent(DIGEST_MEETING_ID, DIGEST));
  });

  it('publishes nothing before the read has answered', async () => {
    let answer!: (digest: MeetingDigest) => void;
    currentOf.mockReturnValue(
      new Promise<MeetingDigest>((resolve) => {
        answer = resolve;
      }),
    );

    const announcing = announcer.announce(DIGEST_MEETING_ID);
    await Promise.resolve();
    expect(publish).not.toHaveBeenCalled();

    answer(DIGEST);
    await announcing;
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('logs a read that fails and publishes nothing: the write it follows is not undone', async () => {
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    currentOf.mockRejectedValue(new Error('connection terminated'));

    await expect(announcer.announce(DIGEST_MEETING_ID)).resolves.toBeUndefined();

    expect(publish).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining(`Digest of meeting ${DIGEST_MEETING_ID}`),
      expect.stringContaining('connection terminated'),
    );
    logged.mockRestore();
  });
});
