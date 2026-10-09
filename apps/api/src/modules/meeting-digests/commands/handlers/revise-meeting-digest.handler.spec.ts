import { Logger } from '@nestjs/common';

import { MeetingDigestAnnouncer } from '../../services/meeting-digest-announcer';
import { MeetingDigestRepository } from '../../services/meeting-digest.repository';
import {
  MeetingDigestRevisionOutcome,
  ReviseMeetingDigestCommand,
} from '../revise-meeting-digest.command';
import { ReviseMeetingDigestHandler } from './revise-meeting-digest.handler';

const MEETING_ID = '44444444-4444-4444-8444-444444444444';

describe('ReviseMeetingDigestHandler', () => {
  const revise = jest.fn();
  const announce = jest.fn();
  const handler = new ReviseMeetingDigestHandler(
    { revise } as unknown as MeetingDigestRepository,
    { announce } as unknown as MeetingDigestAnnouncer,
  );
  const execute = (summary: string, decisions: string[]): Promise<MeetingDigestRevisionOutcome> =>
    handler.execute(new ReviseMeetingDigestCommand(MEETING_ID, summary, decisions));

  afterEach(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    revise.mockReset().mockResolvedValue(true);
    announce.mockReset().mockResolvedValue(undefined);
    // The handler logs each outcome; a spec's report is not where that belongs.
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('stores the revision, trimmed, and tells the open pages once it is stored', async () => {
    await expect(execute(' Moved to May. ', [' Launch in May. '])).resolves.toBe(
      MeetingDigestRevisionOutcome.REVISED,
    );

    expect(revise).toHaveBeenCalledWith(MEETING_ID, {
      summary: 'Moved to May.',
      decisions: ['Launch in May.'],
    });
    expect(announce).toHaveBeenCalledWith(MEETING_ID);
    expect(revise.mock.invocationCallOrder[0]).toBeLessThan(
      announce.mock.invocationCallOrder[0] as number,
    );
  });

  it('answers that there is no digest, and announces nothing, when nothing was written', async () => {
    revise.mockResolvedValue(false);

    await expect(execute('Moved to May.', [])).resolves.toBe(
      MeetingDigestRevisionOutcome.NO_DIGEST,
    );

    expect(announce).not.toHaveBeenCalled();
  });

  it('refuses a revision past the bounds of a digest before anything is written', async () => {
    await expect(execute('   ', ['Launch in May.'])).resolves.toBe(
      MeetingDigestRevisionOutcome.UNFIT,
    );

    expect(revise).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
  });

  it('lets a failed write through, announcing nothing', async () => {
    const failure = new Error('connection lost');
    revise.mockRejectedValue(failure);

    await expect(execute('Moved to May.', [])).rejects.toBe(failure);

    expect(announce).not.toHaveBeenCalled();
  });
});
