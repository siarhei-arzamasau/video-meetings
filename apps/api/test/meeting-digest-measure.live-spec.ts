import { MAX_DIGEST_ITEMS } from '../src/modules/meeting-digests/meeting-digest.constants';
import { LiveMeetingDigest } from './utils/live-meeting-digest';
import {
  longCheckIn,
  longMeetingInRussian,
  meetingDenseWithOutcomes,
  readDigestTranscript,
} from './utils/meeting-digest-fixtures';

const MEASUREMENT_TIMEOUT_MS = 30 * 60 * 1_000;

/**
 * The measurements the digest's cap and time limit are set from. Each is skipped unless asked
 * for, because none is something an ordinary run of `test:live` should pay for:
 *
 * - `MEETING_DIGEST_MEASURE_CHARACTERS=<n>` — a meeting of that many characters, in English.
 *   A million is about 350,000 tokens and cost $0.87 on 2026-10-08.
 * - `MEETING_DIGEST_MEASURE_RUSSIAN_CHARACTERS=<n>` — the same in Russian, the script the cap
 *   is reckoned in. Fifty thousand is enough to drown the instructions' own tokens out.
 * - `MEETING_DIGEST_MEASURE_OUTCOMES=<n>` — a short meeting stating that many action items and
 *   that many decisions, which is what makes an answer long. Fifty is the answer's bound, and
 *   a number past it measures what becomes of a list that has to be cut.
 *
 * `src/config/meeting-digest.defaults.ts` holds what they measured and what was set from it.
 */
const MEASURED_CHARACTERS = Number(process.env['MEETING_DIGEST_MEASURE_CHARACTERS'] ?? 0);
const MEASURED_RUSSIAN_CHARACTERS = Number(
  process.env['MEETING_DIGEST_MEASURE_RUSSIAN_CHARACTERS'] ?? 0,
);
const MEASURED_OUTCOMES = Number(process.env['MEETING_DIGEST_MEASURE_OUTCOMES'] ?? 0);

const CYRILLIC = /[Ѐ-ӿ]/;
/** However the model words the sentence its instructions ask for when a list was cut. */
const SAYS_A_LIST_IS_CUT =
  /not complete|incomplete|not exhaustive|not all|only the most|most important/i;

describe('What a meeting digest costs, against the real Anthropic API', () => {
  let live: LiveMeetingDigest;

  beforeAll(async () => {
    live = await LiveMeetingDigest.start();
  });

  afterAll(async () => {
    await live.close();
  });

  (MEASURED_CHARACTERS > 0 ? it : it.skip)(
    'measures a long meeting, and still reads to the end of the last recording',
    async () => {
      const closing = readDigestTranscript('reference');
      const digest = await live.generateFrom('long', [
        longCheckIn(MEASURED_CHARACTERS - closing.length),
        closing,
      ]);

      // Stated only at the very end of the last recording, after everything else.
      expect(digest.answer.decisions.some((decision) => /april/i.test(decision.description))).toBe(
        true,
      );
      expect(
        digest.answer.actionItems.some((item) => /^Alice Johnson$/i.test(item.ownerName ?? '')),
      ).toBe(true);
    },
    MEASUREMENT_TIMEOUT_MS,
  );

  (MEASURED_RUSSIAN_CHARACTERS > 0 ? it : it.skip)(
    'measures a long meeting held in Russian, which is more tokens to the character',
    async () => {
      const digest = await live.generateFrom('long in Russian', [
        longMeetingInRussian(MEASURED_RUSSIAN_CHARACTERS),
      ]);

      expect(JSON.stringify(digest.answer)).not.toMatch(CYRILLIC);
      expect(digest.answer.decisions.some((decision) => /april/i.test(decision.description))).toBe(
        true,
      );
    },
    MEASUREMENT_TIMEOUT_MS,
  );

  (MEASURED_OUTCOMES > 0 ? it : it.skip)(
    'measures a meeting dense with outcomes, whose answer is as long as answers get',
    async () => {
      const digest = await live.generateFrom('dense', [
        meetingDenseWithOutcomes(MEASURED_OUTCOMES),
      ]);
      const mostAListHolds = Math.min(MEASURED_OUTCOMES, MAX_DIGEST_ITEMS);

      // Nearly all of them, each under its own owner: a count the model may round, not halve.
      // Past the bound the lists are cut to it, and the answer is still a digest — not the
      // failure an over-long list would be under the single turn — whose summary says so.
      expect(digest.answer.actionItems.length).toBeGreaterThanOrEqual(mostAListHolds * 0.9);
      expect(digest.answer.decisions.length).toBeGreaterThanOrEqual(mostAListHolds * 0.9);
      expect(digest.answer.actionItems.every((item) => item.ownerName !== undefined)).toBe(true);
      expect(SAYS_A_LIST_IS_CUT.test(digest.answer.summary)).toBe(
        MEASURED_OUTCOMES > MAX_DIGEST_ITEMS,
      );
    },
    MEASUREMENT_TIMEOUT_MS,
  );
});
