import { Logger } from '@nestjs/common';

import {
  MeetingDigestRevisionOutcome,
  ReviseMeetingDigestCommand,
} from '../meeting-digests/commands/revise-meeting-digest.command';
import {
  MAX_DIGEST_ITEMS,
  MAX_DIGEST_SUMMARY_LENGTH,
} from '../meeting-digests/meeting-digest.constants';
import { MeetingToolName } from './meeting-tools';
import { MEETING_ID, OTHER_MEETING_ID, answerOf, useMeetingTools } from './meeting-tools.fixture';

describe('MeetingTools: update_meeting', () => {
  const { execute, call, accepts } = useMeetingTools();
  const input = {
    meetingId: MEETING_ID,
    summary: ' The launch moves to May. ',
    decisions: ['Launch in May.', ' Hire two. '],
  };

  it('dispatches the revision of the digest, every text trimmed', async () => {
    const answer = await call(MeetingToolName.UPDATE_MEETING, input);

    expect(execute).toHaveBeenCalledWith(
      new ReviseMeetingDigestCommand(MEETING_ID, 'The launch moves to May.', [
        'Launch in May.',
        'Hire two.',
      ]),
    );
    expect(execute.mock.calls[0]?.[0]).toBeInstanceOf(ReviseMeetingDigestCommand);
    expect(answerOf(answer)).toEqual({ meetingId: MEETING_ID, updated: true });
  });

  it('refuses any meeting but the one the server was made for, and dispatches nothing', async () => {
    const answer = await call(MeetingToolName.UPDATE_MEETING, {
      ...input,
      meetingId: OTHER_MEETING_ID,
    });

    expect(answer.isError).toBe(true);
    expect(answer.content[0]?.text).toMatch(/one meeting/);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    [MeetingDigestRevisionOutcome.NO_DIGEST, /no digest yet/],
    [MeetingDigestRevisionOutcome.UNFIT, /blank or too long/],
  ])('answers %s as an error that says why', async (outcome, reason) => {
    execute.mockResolvedValue(outcome);

    const answer = await call(MeetingToolName.UPDATE_MEETING, input);

    expect(answer.isError).toBe(true);
    expect(answer.content[0]?.text).toMatch(reason);
  });

  it.each([
    ['a blank summary', { ...input, summary: '' }],
    ['a summary past the bound', { ...input, summary: 'a'.repeat(MAX_DIGEST_SUMMARY_LENGTH + 1) }],
    ['a blank decision', { ...input, decisions: [' '] }],
    [
      'more decisions than a digest holds',
      { ...input, decisions: Array(MAX_DIGEST_ITEMS + 1).fill('One.') },
    ],
    ['decisions that are not a list', { ...input, decisions: 'Launch in May.' }],
    ['a meeting id that is not an id', { ...input, meetingId: '1' }],
  ])('refuses %s', async (_case, unfit) => {
    await expect(accepts(MeetingToolName.UPDATE_MEETING, unfit)).resolves.toBe(false);
  });

  it('accepts a meeting with no decisions', async () => {
    await expect(
      accepts(MeetingToolName.UPDATE_MEETING, { ...input, decisions: [] }),
    ).resolves.toBe(true);
  });

  it('answers a failed write as an error, and logs the cause', async () => {
    execute.mockRejectedValue(new Error('connection lost'));

    const answer = await call(MeetingToolName.UPDATE_MEETING, input);

    expect(answer).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'The meeting could not be updated.' }],
    });
    expect(Logger.prototype.error).toHaveBeenCalledTimes(1);
  });
});
