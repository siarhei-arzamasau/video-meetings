import { MEETING_FILE_STATUSES } from '@repo/shared';

import { assertTransition, canTransition } from './meeting-file-status';

const ALLOWED = new Set([
  'uploaded>processing',
  'uploaded>deleted',
  'processing>ready',
  'processing>failed',
  'processing>uploaded',
  'processing>deleted',
  'ready>deleted',
  'failed>uploaded',
  'failed>deleted',
]);

describe('the meeting file state machine', () => {
  // Every pair, so an edge added or removed by accident fails here rather than in production.
  const pairs = MEETING_FILE_STATUSES.flatMap((from) =>
    MEETING_FILE_STATUSES.map((to) => [from, to] as const),
  );

  it.each(pairs)('%s to %s', (from, to) => {
    const allowed = ALLOWED.has(`${from}>${to}`);

    expect(canTransition(from, to)).toBe(allowed);

    if (allowed) {
      expect(() => assertTransition(from, to)).not.toThrow();
    } else {
      expect(() => assertTransition(from, to)).toThrow(`cannot move from ${from} to ${to}`);
    }
  });

  it('makes deleted terminal', () => {
    expect(MEETING_FILE_STATUSES.some((to) => canTransition('deleted', to))).toBe(false);
  });
});
