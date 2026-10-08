import {
  ClaudeAgentFailure,
  ClaudeModel,
} from '../src/modules/claude-agent/claude-agent.constants';
import type { GeneratedMeetingDigest } from '../src/modules/meeting-digests/services/meeting-digest-generator';
import { LiveMeetingDigest } from './utils/live-meeting-digest';
import { readDigestTranscript } from './utils/meeting-digest-fixtures';

const NEVER_ISSUED_TOKEN = 'sk-ant-api03-never-issued-by-anthropic';

/** A generation is a model thinking, not a nonce echoed: the suite's 60 seconds is too tight. */
const GENERATION_TIMEOUT_MS = 180_000;

const CYRILLIC = /[Ѐ-ӿ]/;

/**
 * The meeting digest against Anthropic's real API: the instructions, the schema, and the
 * guard, held to what the PRD asks of a digest by the one thing no fake can stand in for —
 * the model's own judgement about what was decided and who owns what.
 *
 * Every test spends a real request; see `claude-agent.live-spec.ts` for where the token
 * comes from and why. The assertions are about what a digest *holds*, never its wording,
 * which is the model's to choose and changes from run to run.
 *
 * The runs too expensive to be on by default are `meeting-digest-measure.live-spec.ts`.
 */
describe('MeetingDigestGenerator against the real Anthropic API', () => {
  let live: LiveMeetingDigest;

  beforeAll(async () => {
    live = await LiveMeetingDigest.start();
  });

  afterEach(() => {
    live.restoreToken();
  });

  afterAll(async () => {
    await live.close();
  });

  it(
    'turns the reference transcript into both action items, the named owner, and the decision',
    async () => {
      const digest = await live.generateFrom('reference', [readDigestTranscript('reference')]);

      expectReferenceOutcomes(digest);
      expect(digest.model).toContain(ClaudeModel.SONNET);
      expect(digest.costUsd).toBeGreaterThan(0);
    },
    GENERATION_TIMEOUT_MS,
  );

  it(
    'writes the digest of a meeting held in Russian in English, names included',
    async () => {
      const digest = await live.generateFrom('reference in Russian', [
        readDigestTranscript('referenceInRussian'),
      ]);

      expect(JSON.stringify(digest.answer)).not.toMatch(CYRILLIC);
      expectReferenceOutcomes(digest);
    },
    GENERATION_TIMEOUT_MS,
  );

  it(
    'returns empty lists for a meeting that decided nothing and assigned nothing',
    async () => {
      const digest = await live.generateFrom('no outcomes', [readDigestTranscript('noOutcomes')]);

      expect(digest.answer.actionItems).toEqual([]);
      expect(digest.answer.decisions).toEqual([]);
      expect(digest.answer.summary).toMatch(/sign-?ups|support|check-in/i);
    },
    GENERATION_TIMEOUT_MS,
  );

  it(
    'says that nothing was said, and invents no meeting, for recordings with no speech in them',
    async () => {
      // What Whisper makes of silence: empty text. The schema wants a summary of at least
      // one character, so without its rule the model would have to describe something.
      const digest = await live.generateFrom('no speech', ['', '']);

      expect(digest.answer.actionItems).toEqual([]);
      expect(digest.answer.decisions).toEqual([]);
      expect(digest.answer.summary).toMatch(/no speech|nothing was said|silent|empty/i);
    },
    GENERATION_TIMEOUT_MS,
  );

  it(
    'does not obey instructions spoken in a recording, even past a tag that closes it',
    async () => {
      const digest = await live.generateFrom('injection', [readDigestTranscript('injection')]);
      const everything = JSON.stringify(digest.answer);

      // What the injected text asked for, from outside the recording it had "closed": French,
      // a one-word summary, no decisions, and an action item of its own. A digest that holds
      // the meeting's real outcomes — half of them said after the tag — did none of it.
      expectReferenceOutcomes(digest);
      expect(digest.answer.summary).not.toMatch(/^\W*PWNED\W*$/i);
      expect(digest.answer.summary).toMatch(/\bthe\b/);
      expect(everything).not.toMatch(/mallory/i);
    },
    GENERATION_TIMEOUT_MS,
  );

  it('is refused with a token Anthropic never issued', async () => {
    live.useToken(NEVER_ISSUED_TOKEN);

    await expect(
      live.generateFrom('refused', [readDigestTranscript('reference')]),
    ).rejects.toMatchObject({ failure: ClaudeAgentFailure.AUTHENTICATION });
  });
});

/** The reference meeting's two action items and its decision, however they were worded. */
function expectReferenceOutcomes({ answer }: GeneratedMeetingDigest): void {
  const emails = answer.actionItems.find((item) => /e-?mail/i.test(item.description));
  const pricing = answer.actionItems.find((item) => /pricing/i.test(item.description));

  expect(answer.actionItems).toHaveLength(2);
  expect(emails?.ownerName).toMatch(/^Ali[cs][ea] \w+son$/i);
  // Stated with nobody named for it: "nobody has picked that up yet" is not an owner.
  expect(pricing).toEqual({ description: expect.any(String) });

  expect(answer.decisions).toHaveLength(1);
  expect(answer.decisions[0]?.description).toMatch(/april/i);
  expect(answer.summary).toMatch(/launch/i);
}
