import type { MeetingFile } from '@repo/shared';

/** As much of a row as an announcement about its transcription needs. */
type Followed = Pick<MeetingFile, 'id' | 'name' | 'transcriptionStatus'>;

/** Queued or running: a transcription whose end somebody may still be waiting to hear. */
const isUnderWay = ({ transcriptionStatus }: Followed): boolean =>
  transcriptionStatus === 'queued' || transcriptionStatus === 'transcribing';

/**
 * What a screen reader is told when a transcription the page was following ends, or `null`
 * when none did.
 *
 * **Only the two ends are announced** — a transcript that is ready, a transcription that
 * failed — because they are what a listener can act on: open the one, look into the other.
 * Queued and Transcribing… are steps on the way, and a phrase for each would be three
 * interruptions per recording where one says everything.
 *
 * **Only for a row that was seen under way.** A recording that arrives already finished is
 * the page's opening state or somebody else's file, and a failed one going back to the queue
 * is the listener's own Retry. Neither is news.
 *
 * One file is named and several are counted, as `processingAnnouncement` counts: a list of
 * file names read in one breath is not something anyone follows.
 */
export function transcriptionAnnouncement(
  previous: ReadonlyArray<Followed>,
  current: ReadonlyArray<Followed>,
): string | null {
  const underWay = new Set(previous.filter(isUnderWay).map(({ id }) => id));
  const followed = current.filter(({ id }) => underWay.has(id));
  const phrases = [
    readyPhrase(followed.filter((file) => file.transcriptionStatus === 'transcribed')),
    failedPhrase(followed.filter((file) => file.transcriptionStatus === 'failed')),
  ].filter((phrase) => phrase !== null);

  return phrases.length === 0 ? null : phrases.join(' ');
}

function readyPhrase(transcribed: ReadonlyArray<Followed>): string | null {
  const [first] = transcribed;

  if (first === undefined) {
    return null;
  }

  return transcribed.length === 1
    ? `The transcript of ${first.name} is ready.`
    : `${String(transcribed.length)} transcripts are ready.`;
}

function failedPhrase(failed: ReadonlyArray<Followed>): string | null {
  const [first] = failed;

  if (first === undefined) {
    return null;
  }

  return failed.length === 1
    ? `Transcription of ${first.name} failed.`
    : `${String(failed.length)} transcriptions failed.`;
}
