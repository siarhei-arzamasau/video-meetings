import type { Logger } from '@nestjs/common';

import { startLeaseHeartbeat } from '../../../common/processing/lease-heartbeat';
import type { LeaseRenewer } from '../../../common/processing/lease-heartbeat';
import type { MeetingTranscripts } from '../../meeting-files/queries/find-meeting-transcripts.query';
import { MAX_DIGEST_TRANSCRIPT_CHARACTERS } from '../meeting-digest.constants';
import { MeetingDigestError, MeetingDigestFailure } from '../meeting-digest.error';
import type { ClaimedDigest } from '../services/meeting-digest-claim.repository';
import type { GeneratedMeetingDigest } from '../services/meeting-digest-generator';

/** What hung up on a generation. The first of them to fire is the one that ended it. */
export enum DigestInterruption {
  TIME_LIMIT = 'TIME_LIMIT',
  SHUTDOWN = 'SHUTDOWN',
  CLAIM_LOST = 'CLAIM_LOST',
}

export type DigestRunOutcome =
  | { generated: GeneratedMeetingDigest; sourceFileIds: ReadonlyArray<string> }
  /** The meeting has no transcribed recording left: there is nothing to send. */
  | { nothingToGenerate: true }
  | { error: unknown };

/** How one generation ended, with what the caller needs to record it. */
export interface DigestRun {
  /** The lease the row holds now — `null` once a renewal found the claim gone. */
  held: Date | null;
  outcome: DigestRunOutcome;
  /** What had hung up on the generator when it settled, if anything had. */
  interruptedBy: DigestInterruption | null;
}

export interface DigestRunOptions {
  claimed: ClaimedDigest;
  /** The meeting's transcripts in upload order, or the fact that they are past the cap. */
  readTranscripts: (meetingId: string) => Promise<MeetingTranscripts>;
  generate: (
    transcripts: ReadonlyArray<string>,
    signal: AbortSignal,
  ) => Promise<GeneratedMeetingDigest>;
  leases: LeaseRenewer;
  logger: Logger;
  leaseSeconds: number;
  limitSeconds: number;
  /** Aborted when the process is shutting down. */
  shutdown: AbortSignal;
}

/**
 * Reads a meeting's transcripts and asks for one digest of them, keeping the claim's lease
 * alive meanwhile, and reports how it ended. It writes nothing: what the row is told is the
 * caller's decision.
 *
 * Three things hang up on the generator, and the caller is told which did: the time limit,
 * shutdown, and a renewal that found the claim gone, after which `held` is `null` and there
 * is nothing left to write. **Which one is read from the signal's own reason, as the
 * generator settles** — the first to fire is the reason an `AbortSignal.any` carries. The
 * rejection trails an abort by up to two seconds, the SDK's grace, so two flags read at that
 * moment could both be up: a deploy that begins just after the limit fired would hand the
 * claim back to be run, and to time out, again. And a signal that fires after the generator
 * has settled did not end it, which is why nothing is read once the heartbeat is stopping.
 *
 * The time limit bounds the request to Claude and starts with it; reading the transcripts
 * off the local disk is not what the limit is a measurement of.
 */
export async function runDigestGeneration(options: DigestRunOptions): Promise<DigestRun> {
  const { claimed, leases, logger, leaseSeconds, shutdown } = options;
  const claimLost = new AbortController();
  const heartbeat = startLeaseHeartbeat({
    leases,
    logger,
    claimId: claimed.id,
    subject: `Digest of meeting ${claimed.meetingId}`,
    lease: claimed.leasedUntil,
    leaseSeconds,
    onLost: () => claimLost.abort(),
  });
  let outcome: DigestRunOutcome;
  let interruptedBy: DigestInterruption | null = null;

  // Everything up to `heartbeat.stop()` is inside the `try`: a throw that escaped would
  // leave the heartbeat renewing a claim nobody is working on, and a row that says
  // generating for as long as the process lives.
  try {
    const transcripts = await options.readTranscripts(claimed.meetingId);
    const timeLimit = AbortSignal.timeout(options.limitSeconds * 1_000);
    const signal = AbortSignal.any([shutdown, claimLost.signal, timeLimit]);

    try {
      outcome = await generateFrom(transcripts, options.generate, signal);
    } finally {
      interruptedBy = interruptionOf(signal, timeLimit, shutdown);
    }
  } catch (error) {
    outcome = { error };
  }

  return { held: await heartbeat.stop(), outcome, interruptedBy };
}

async function generateFrom(
  transcripts: MeetingTranscripts,
  generate: DigestRunOptions['generate'],
  signal: AbortSignal,
): Promise<DigestRunOutcome> {
  if (!transcripts.withinLimit) {
    // The read stopped at the cap, so there is no text to hand the generator — whose own cap
    // would refuse the same transcripts, but only after holding all of them to count them.
    throw new MeetingDigestError(
      MeetingDigestFailure.TRANSCRIPTS_TOO_LONG,
      `The transcripts are past the cap of ${MAX_DIGEST_TRANSCRIPT_CHARACTERS} characters; nothing was sent`,
    );
  }

  if (transcripts.transcripts.length === 0) {
    return { nothingToGenerate: true };
  }

  const generated = await generate(
    transcripts.transcripts.map(({ text }) => text),
    signal,
  );

  return { generated, sourceFileIds: transcripts.transcripts.map(({ fileId }) => fileId) };
}

function interruptionOf(
  signal: AbortSignal,
  timeLimit: AbortSignal,
  shutdown: AbortSignal,
): DigestInterruption | null {
  if (!signal.aborted) {
    return null;
  }

  if (timeLimit.aborted && signal.reason === timeLimit.reason) {
    return DigestInterruption.TIME_LIMIT;
  }

  return shutdown.aborted && signal.reason === shutdown.reason
    ? DigestInterruption.SHUTDOWN
    : DigestInterruption.CLAIM_LOST;
}
