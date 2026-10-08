import {
  TranscriptionStatus,
  assertTranscriptionTransition,
  canTranscriptionTransition,
} from './meeting-file-transcription-status';

const STATUSES = Object.values(TranscriptionStatus);

const ALLOWED = new Set([
  'QUEUED>TRANSCRIBING',
  'TRANSCRIBING>TRANSCRIBED',
  'TRANSCRIBING>FAILED',
  'TRANSCRIBING>QUEUED',
  'FAILED>QUEUED',
]);

describe('the transcription state machine', () => {
  it('stores the four statuses in upper case, as the Prisma rule asks of an enum', () => {
    expect(STATUSES).toEqual(['QUEUED', 'TRANSCRIBING', 'TRANSCRIBED', 'FAILED']);
  });

  // Every pair, so an edge added or removed by accident fails here rather than in production.
  const pairs = STATUSES.flatMap((from) => STATUSES.map((to) => [from, to] as const));

  it.each(pairs)('%s to %s', (from, to) => {
    const allowed = ALLOWED.has(`${from}>${to}`);

    expect(canTranscriptionTransition(from, to)).toBe(allowed);

    if (allowed) {
      expect(() => assertTranscriptionTransition(from, to)).not.toThrow();
    } else {
      expect(() => assertTranscriptionTransition(from, to)).toThrow(
        `cannot move from ${from} to ${to}`,
      );
    }
  });

  it('makes transcribed terminal', () => {
    expect(
      STATUSES.some((to) => canTranscriptionTransition(TranscriptionStatus.TRANSCRIBED, to)),
    ).toBe(false);
  });
});
