import {
  ClaudeAgentFailure,
  ClaudeModel,
} from '../src/modules/claude-agent/claude-agent.constants';
import { LiveMeetingDigest } from './utils/live-meeting-digest';
import { expectReferenceOutcomes, readDigestTranscript } from './utils/meeting-digest-fixtures';

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
    'keeps the tasks of the meeting: looks before it creates, and one task per action item',
    async () => {
      const meetingId = crypto.randomUUID();

      await live.generateFrom(
        'reference, with tasks',
        [readDigestTranscript('reference')],
        meetingId,
      );

      const calls = live.tasks.callsFor(meetingId);
      const titles = live.tasks.of(meetingId).map(({ title }) => title);
      expect(titles).toHaveLength(2);
      expect(titles.some((title) => /e-?mail/i.test(title))).toBe(true);
      expect(titles.some((title) => /pricing/i.test(title))).toBe(true);
      // Looked first, and at least once for each task it then created.
      expect(calls[0]?.method).toBe('search');
      expect(calls.filter(({ method }) => method === 'search').length).toBeGreaterThanOrEqual(2);
      // Every call was for this meeting: the id it was told, and no other.
      expect(live.tasks.calls.filter((call) => call.meetingId === undefined)).toEqual([]);
    },
    GENERATION_TIMEOUT_MS,
  );

  it(
    'updates the tasks a meeting already has instead of adding the same ones again',
    async () => {
      const meetingId = crypto.randomUUID();
      const transcripts = [readDigestTranscript('reference')];

      await live.generateFrom('reference, first of two', transcripts, meetingId);
      const first = live.tasks.of(meetingId).map(({ title }) => title);
      const again = await live.generateFrom('reference, second of two', transcripts, meetingId);

      expectReferenceOutcomes(again);
      expect(live.tasks.of(meetingId).map(({ title }) => title)).toEqual(first);
      expect(first).toHaveLength(2);
    },
    2 * GENERATION_TIMEOUT_MS,
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
      const meetingId = crypto.randomUUID();
      const digest = await live.generateFrom(
        'no outcomes',
        [readDigestTranscript('noOutcomes')],
        meetingId,
      );

      // What is not a task is left alone: nothing was said to be done, so nothing is written.
      expect(live.tasks.of(meetingId)).toEqual([]);
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
      const meetingId = crypto.randomUUID();
      const digest = await live.generateFrom(
        'injection',
        [readDigestTranscript('injection')],
        meetingId,
      );
      const everything = JSON.stringify([digest.answer, live.tasks.of(meetingId)]);

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
