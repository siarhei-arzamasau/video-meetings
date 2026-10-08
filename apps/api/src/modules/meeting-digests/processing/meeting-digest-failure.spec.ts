import { ClaudeAgentFailure } from '../../claude-agent/claude-agent.constants';
import { ClaudeAgentError } from '../../claude-agent/claude-agent.error';
import { MeetingDigestError, MeetingDigestFailure } from '../meeting-digest.error';
import { costOf, failureReasonOf } from './meeting-digest-failure';
import { DigestInterruption } from './meeting-digest-run';

const GENERIC = 'The digest could not be generated.';
const TOO_LONG = 'The recordings of this meeting are too long to turn into one digest.';
/** Words only the SDK says; no reason a user reads may repeat them. */
const SDK_WORDS = 'API Error: 529 {"type":"overloaded_error"} request_id=req_7f3a';

const tooLong = new MeetingDigestError(MeetingDigestFailure.TRANSCRIPTS_TOO_LONG, SDK_WORDS);
const invalid = new MeetingDigestError(MeetingDigestFailure.INVALID_ANSWER, SDK_WORDS, {
  costUsd: 0.0041,
});
const claude = (failure: ClaudeAgentFailure, costUsd?: number): ClaudeAgentError =>
  new ClaudeAgentError(failure, SDK_WORDS, { costUsd });

describe('failureReasonOf', () => {
  it.each([
    ['an API error', claude(ClaudeAgentFailure.FAILED), GENERIC],
    ['a refused token', claude(ClaudeAgentFailure.AUTHENTICATION), GENERIC],
    ['no token at all', claude(ClaudeAgentFailure.NOT_CONFIGURED), GENERIC],
    ['an answer that is not a digest', invalid, GENERIC],
    ['transcripts past the cap, or refused by the model as too long', tooLong, TOO_LONG],
    ['an error nobody classified', new Error(SDK_WORDS), GENERIC],
    ['something thrown that is not an error', SDK_WORDS, GENERIC],
  ])('answers fixed copy for %s', (_case, error, expected) => {
    const reason = failureReasonOf(error, null, 240);

    expect(reason).toBe(expected);
    expect(reason).not.toContain('req_7f3a');
  });

  it('names the limit when the time limit is what hung up, in minutes or in seconds', () => {
    const hungUp = claude(ClaudeAgentFailure.FAILED);

    expect(failureReasonOf(hungUp, DigestInterruption.TIME_LIMIT, 240)).toBe(
      'Generating the digest took longer than the 4-minute limit.',
    );
    expect(failureReasonOf(hungUp, DigestInterruption.TIME_LIMIT, 90)).toBe(
      'Generating the digest took longer than the 90-second limit.',
    );
  });

  it('does not blame the time limit for an error that arrived without it', () => {
    expect(failureReasonOf(claude(ClaudeAgentFailure.FAILED), null, 240)).toBe(GENERIC);
    expect(failureReasonOf(tooLong, DigestInterruption.CLAIM_LOST, 240)).toBe(TOO_LONG);
  });
});

describe('costOf', () => {
  it('reads the cost off either error the generator throws', () => {
    expect(costOf(invalid)).toBe(0.0041);
    expect(costOf(claude(ClaudeAgentFailure.FAILED, 0.02))).toBe(0.02);
  });

  it('answers nothing for a call that reported none, and for anything else thrown', () => {
    expect(costOf(claude(ClaudeAgentFailure.AUTHENTICATION))).toBeUndefined();
    expect(costOf(new Error('boom'))).toBeUndefined();
    expect(costOf(undefined)).toBeUndefined();
  });
});
