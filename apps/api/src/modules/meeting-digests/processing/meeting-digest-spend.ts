import { MEETING_DIGEST_MODEL } from '../meeting-digest.constants';
import { costOf } from './meeting-digest-failure';
import type { DigestRunOutcome } from './meeting-digest-run';

/** A call to Claude that reported what it cost, as the log names it. */
export interface GenerationSpend {
  model: string;
  costUsd: number;
}

/**
 * What a run spent on Claude, or `null` when no call reported a cost — none was made, or the
 * one that was never got as far as a result. An answer, kept or discarded, and both of the
 * generator's errors carry it.
 */
export function spendOf(outcome: DigestRunOutcome): GenerationSpend | null {
  if ('generated' in outcome) {
    return { model: outcome.generated.model, costUsd: outcome.generated.costUsd };
  }

  const costUsd = 'error' in outcome ? costOf(outcome.error) : undefined;

  return costUsd === undefined ? null : { model: MEETING_DIGEST_MODEL, costUsd };
}

/** A cost as the SDK reported it, to the hundredth of a cent a short generation is priced in. */
export function usd(costUsd: number): string {
  return `$${costUsd.toFixed(4)}`;
}
