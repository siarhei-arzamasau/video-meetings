import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { GeneratedMeetingDigest } from '../../src/modules/meeting-digests/services/meeting-digest-generator';

const DIRECTORY = join(__dirname, '..', 'fixtures', 'meeting-digest');

/**
 * The reference transcripts of the meeting digest, in `test/fixtures/meeting-digest`.
 *
 * - `reference` — the PRD's script: two action items, one naming a person (Alice Johnson,
 *   the onboarding emails, by Friday) and one naming nobody (the pricing page), and one
 *   decision (the public launch moves to 15 April).
 * - `referenceInRussian` — the same meeting, spoken in Russian.
 * - `noOutcomes` — a check-in in which nothing is decided and nobody takes anything on.
 * - `injection` — the reference with text addressed to the model in the middle of it, and
 *   HTML: it asks for French, a one-word summary, no decisions, and an action item of its own.
 *   It asks from outside the recording, as far as tags go: a `</recording>` comes before it
 *   and a `<recording number="2">` after, which is the most a transcript can do, since the
 *   prompt builder escapes nothing. Half of the meeting's outcomes are said after them.
 *
 * `REFERENCE_RECORDING` is the reference script spoken aloud, 26 seconds of M4A, for the
 * manual runs that need a real recording through a real Whisper. It was made on macOS with
 * nothing installed, and is remade the same way when the script changes:
 *
 *     say -v Samantha -o reference.aiff -f reference.en.txt
 *     afconvert -f m4af -d aac@22050 -b 24000 -c 1 reference.aiff reference-recording.m4a
 *
 * What Whisper hears is not the script to the letter — a name is the first thing it respells
 * — so a spec asserts on the transcripts here and never on a transcription of the recording.
 *
 * The builders at the bottom make the transcripts of `test:live`'s opt-in measurements.
 */
const TRANSCRIPT_FILES = {
  reference: 'reference.en.txt',
  referenceInRussian: 'reference.ru.txt',
  noOutcomes: 'no-outcomes.en.txt',
  injection: 'injection.en.txt',
} as const;

export type DigestTranscript = keyof typeof TRANSCRIPT_FILES;

export const REFERENCE_RECORDING = join(DIRECTORY, 'reference-recording.m4a');

export function readDigestTranscript(transcript: DigestTranscript): string {
  return readFileSync(join(DIRECTORY, TRANSCRIPT_FILES[transcript]), 'utf8').trim();
}

const FIRST_NAMES = ['Alice', 'Brian', 'Carla', 'David', 'Elena', 'Frank', 'Grace', 'Henry'];
const LAST_NAMES = ['Johnson', 'Miller', 'Novak', 'Okafor', 'Perez', 'Quinn', 'Rossi', 'Smith'];

/** A meeting that states `count` tasks, each with a different owner, and `count` decisions. */
export function meetingDenseWithOutcomes(count: number): string {
  return Array.from({ length: count }, (_, index) => {
    const region = index + 1;
    const firstName = FIRST_NAMES[index % FIRST_NAMES.length];
    const lastName = LAST_NAMES[Math.floor(index / FIRST_NAMES.length) % LAST_NAMES.length];

    return (
      `${firstName} ${lastName} will send the quarterly report for region ${region} by the end ` +
      `of the month. We decided that region ${region} keeps its current budget for next year.`
    );
  }).join(' ');
}

/**
 * Speech of a given length in which nothing is decided: the check-in fixture, said again for
 * week after week. Prose rather than filler characters, because what is being measured is
 * tokens, and a token is not a fixed number of characters across kinds of text.
 */
export function longCheckIn(characters: number): string {
  const week = readDigestTranscript('noOutcomes');

  return saidAgain((number) => `Week ${number}. ${week}`, characters);
}

/**
 * The reference meeting in Russian, held again week after week, to a given length. For the
 * one number the short Russian fixture cannot give: how many characters of Russian a token
 * is, measured on enough of it that the instructions' own tokens no longer matter.
 */
export function longMeetingInRussian(characters: number): string {
  const week = readDigestTranscript('referenceInRussian');

  return saidAgain((number) => `Неделя ${number}. ${week}`, characters);
}

function saidAgain(sayWeek: (number: number) => string, characters: number): string {
  const weeks: string[] = [];
  let length = 0;

  for (let number = 1; length < characters; number += 1) {
    const said = sayWeek(number);
    weeks.push(said);
    length += said.length + 1;
  }

  return weeks.join(' ').slice(0, characters);
}

/** The reference meeting's two action items and its decision, however they were worded. */
export function expectReferenceOutcomes({ answer }: GeneratedMeetingDigest): void {
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
