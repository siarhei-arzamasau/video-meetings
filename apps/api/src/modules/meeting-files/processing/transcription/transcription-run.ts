import type { Logger } from '@nestjs/common';

import type { MeetingFileRecord } from '../../services/meeting-file.mapper';
import type { MeetingFileStorage } from '../../storage/meeting-file-storage';
import { startLeaseHeartbeat } from '../lease-heartbeat';
import type { LeaseRenewer } from '../lease-heartbeat';
import type { TranscriptionProvider } from './transcription-provider';

/** How one request to the provider ended, with what the caller needs to record it. */
export interface TranscriptionRun {
  /** The lease the row holds now — `null` once a renewal found the claim gone. */
  held: Date | null;
  outcome: { text: string } | { error: unknown };
  /** Whether the time limit fired, which is what makes a failure name it. */
  timedOut: boolean;
}

export interface TranscriptionRunOptions {
  /** The claimed row. Its `transcriptionLeasedUntil` is the lease the claim was given. */
  claimed: MeetingFileRecord;
  provider: TranscriptionProvider;
  storage: MeetingFileStorage;
  leases: LeaseRenewer;
  logger: Logger;
  leaseSeconds: number;
  limitSeconds: number;
  /** Aborted when the process is shutting down. */
  shutdown: AbortSignal;
}

/**
 * Asks the provider for one transcript, keeping the claim's lease alive meanwhile, and
 * reports how it ended. It writes nothing: what the row is told is the caller's decision.
 *
 * Three things end the request early, and the caller can tell which: the time limit
 * (`timedOut`), shutdown (the signal it passed in), and a renewal that found the claim gone —
 * the file deleted, or the lease lapsed and reclaimed — after which `held` is `null` and there
 * is nothing left to write. The last is why the heartbeat is given an `onLost`: a
 * transcription runs for minutes, and nobody is left to read the answer.
 *
 * The heartbeat is stopped before this returns, so the caller's conditional writes are made
 * against a lease no renewal is about to replace.
 */
export async function runTranscription({
  claimed,
  provider,
  storage,
  leases,
  logger,
  leaseSeconds,
  limitSeconds,
  shutdown,
}: TranscriptionRunOptions): Promise<TranscriptionRun> {
  const timeLimit = AbortSignal.timeout(limitSeconds * 1_000);
  const claimLost = new AbortController();
  const heartbeat = startLeaseHeartbeat({
    files: leases,
    logger,
    fileId: claimed.id,
    meetingId: claimed.meetingId,
    lease: claimed.transcriptionLeasedUntil,
    leaseSeconds,
    onLost: () => claimLost.abort(),
  });
  // The provider never sees a path: the object is opened by key and streamed, so a gigabyte
  // of video costs a chunk of memory.
  const stream = storage.openRead(claimed.storageKey);
  // For a stream nobody is reading — the provider returned early, or the purge removed the
  // object mid-request — whose `error` event would otherwise be unhandled and end the process.
  stream.on('error', () => undefined);
  let outcome: TranscriptionRun['outcome'];

  try {
    const signal = AbortSignal.any([shutdown, claimLost.signal, timeLimit]);

    outcome = { text: await provider.transcribe(stream, claimed.contentType, signal) };
  } catch (error) {
    outcome = { error };
  } finally {
    // Opened here, so closed here: a provider that never touched it must not leak a descriptor.
    stream.destroy();
  }

  return { held: await heartbeat.stop(), outcome, timedOut: timeLimit.aborted };
}
