import type { MeetingFile } from '@repo/shared';

/** What a row's Retry sends back to a worker: the file itself, or only its transcription. */
export type RetryTarget = 'file' | 'transcription';

/**
 * Which of the two a row's Retry is for, or `null` when nothing on it failed.
 *
 * **At most one, which is why the row has one Retry and not two.** A file that failed its
 * checks was never queued for transcription, and a recording whose transcription failed is
 * `ready` — the API writes no row that is both. The file is asked about first all the same:
 * nothing transcribes a file that is not ready, so if a row ever claimed both, that is the
 * retry that could help.
 */
export function retryTargetOf(
  file: Pick<MeetingFile, 'status' | 'transcriptionStatus'>,
): RetryTarget | null {
  if (file.status === 'failed') {
    return 'file';
  }

  return file.transcriptionStatus === 'failed' ? 'transcription' : null;
}
