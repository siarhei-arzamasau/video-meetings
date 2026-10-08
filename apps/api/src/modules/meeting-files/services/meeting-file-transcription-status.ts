/**
 * A transcription's stored status — Prisma's `MeetingFileTranscriptionStatus`, spelled out so
 * nothing that names one needs the generated client; the model satisfies it structurally.
 *
 * UPPER_CASE, as `.claude/rules/prisma.md` asks of an enum, while the wire vocabulary in
 * `@repo/shared` is lower-case. `meeting-file.mapper.ts` is the one place that translates.
 */
export const TranscriptionStatus = {
  QUEUED: 'QUEUED',
  TRANSCRIBING: 'TRANSCRIBING',
  TRANSCRIBED: 'TRANSCRIBED',
  FAILED: 'FAILED',
} as const;

export type TranscriptionStatus = (typeof TranscriptionStatus)[keyof typeof TranscriptionStatus];

/**
 * The edges a transcription may take once it has a status. Getting one — nothing → `QUEUED` —
 * is not here because it is not a transcription write at all: it is a column of the file
 * worker's `processing → ready` update, which is what makes "ready" and "queued" one statement.
 *
 * - `QUEUED → TRANSCRIBING` is the claim, which also re-claims a `TRANSCRIBING` row whose lease
 *   has lapsed without changing its status.
 * - `TRANSCRIBING → QUEUED` is the release a graceful shutdown makes.
 * - `FAILED → QUEUED` is the retry. Nothing takes it yet: its one caller is the retry route.
 *
 * `TRANSCRIBED` is terminal.
 */
const TRANSITIONS: Record<TranscriptionStatus, ReadonlyArray<TranscriptionStatus>> = {
  QUEUED: [TranscriptionStatus.TRANSCRIBING],
  TRANSCRIBING: [
    TranscriptionStatus.TRANSCRIBED,
    TranscriptionStatus.FAILED,
    TranscriptionStatus.QUEUED,
  ],
  TRANSCRIBED: [],
  FAILED: [TranscriptionStatus.QUEUED],
};

export function canTranscriptionTransition(
  from: TranscriptionStatus,
  to: TranscriptionStatus,
): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Throws naming both states, so a bad edge is a bug report rather than a silent write. */
export function assertTranscriptionTransition(
  from: TranscriptionStatus,
  to: TranscriptionStatus,
): void {
  if (!canTranscriptionTransition(from, to)) {
    throw new Error(`A transcription cannot move from ${from} to ${to}`);
  }
}
