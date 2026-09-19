import type { MeetingFileStatus } from '@repo/shared';

/**
 * The PRD's F7 graph, plus two edges the worker relies on:
 *
 * - `failed → uploaded` is the explicit retry (no route calls it yet).
 * - `processing → uploaded` is lease expiry — the claim query performs it implicitly by
 *   re-claiming a `processing` row whose lease has passed, and it is modelled here so the
 *   spec pins that a lost worker's row goes back to the start rather than anywhere else.
 *
 * `deleted` is terminal.
 */
const TRANSITIONS: Record<MeetingFileStatus, ReadonlyArray<MeetingFileStatus>> = {
  uploaded: ['processing', 'deleted'],
  processing: ['ready', 'failed', 'uploaded', 'deleted'],
  ready: ['deleted'],
  failed: ['uploaded', 'deleted'],
  deleted: [],
};

export function canTransition(from: MeetingFileStatus, to: MeetingFileStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Throws naming both states, so a bad edge is a bug report rather than a silent write. */
export function assertTransition(from: MeetingFileStatus, to: MeetingFileStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`A meeting file cannot move from ${from} to ${to}`);
  }
}
