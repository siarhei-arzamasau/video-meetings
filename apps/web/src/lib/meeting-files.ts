import type { MeetingFile } from '@repo/shared';
import {
  MAX_CHUNKED_MEETING_FILE_SIZE_BYTES,
  MAX_MEETING_FILE_NAME_LENGTH,
  MAX_MEETING_FILE_SIZE_BYTES,
  MEETING_FILE_ACCEPT,
  MEETING_FILE_CHUNKED_SIZE_MESSAGE,
  MEETING_FILE_EMPTY_MESSAGE,
  MEETING_FILE_NAME_MESSAGE,
  MEETING_FILE_PROCESSING_FAILED_MESSAGE,
  MEETING_FILE_TYPE_MESSAGE,
} from '@repo/shared';

/**
 * The upload copy, from the same constants the API sends: a check that runs here before the
 * round trip reads exactly like the server's rejection of the same file.
 */
export const SIZE_MESSAGE = MEETING_FILE_CHUNKED_SIZE_MESSAGE;
export const TYPE_MESSAGE = MEETING_FILE_TYPE_MESSAGE;
export const EMPTY_MESSAGE = MEETING_FILE_EMPTY_MESSAGE;
export const NAME_MESSAGE = MEETING_FILE_NAME_MESSAGE;

const UNITS = ['B', 'KB', 'MB', 'GB'] as const;

/**
 * Bytes as a short human size: `329 B`, `11 KB`, `1.2 MB`. Binary units, one decimal below
 * ten, none above — the point is a glance, not accounting.
 */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '';
  }

  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }

  const rounded =
    unit === 0 ? String(value) : value < 10 ? value.toFixed(1) : String(Math.round(value));

  return `${rounded.replace(/\.0$/, '')} ${UNITS[unit] ?? 'B'}`;
}

/**
 * What the row shows for a status. `uploaded` and `processing` collapse into one: the
 * difference is the worker's, not the user's. `ready` shows nothing — it is the default, and
 * a chip on every row is noise.
 */
export type StatusPresentation =
  | { kind: 'processing' }
  | { kind: 'ready' }
  | { kind: 'failed'; reason: string };

export function statusPresentation(
  file: Pick<MeetingFile, 'status' | 'failureReason'>,
): StatusPresentation {
  switch (file.status) {
    case 'uploaded':
    case 'processing':
      return { kind: 'processing' };
    case 'failed':
      return {
        kind: 'failed',
        reason: file.failureReason ?? MEETING_FILE_PROCESSING_FAILED_MESSAGE,
      };
    case 'ready':
    case 'deleted':
      return { kind: 'ready' };
  }
}

/** The extension of a name, lowercased, with the dot — or `''` when there is none. */
function extensionOf(name: string): string {
  const trimmed = name.trim();
  const dot = trimmed.lastIndexOf('.');

  return dot <= 0 ? '' : trimmed.slice(dot).toLowerCase();
}

/**
 * Whether a file goes through the chunked path. The single-request route still enforces its
 * own 100 MB cap server-side, so this is not a preference — a larger file sent that way is a
 * 413.
 */
export function isChunkedUpload(file: Pick<File, 'size'>): boolean {
  return file.size > MAX_MEETING_FILE_SIZE_BYTES;
}

/**
 * The checks worth a round trip: size, emptiness, name, and type by extension. `file.type`
 * is not used for the type — browsers report it inconsistently for Markdown and CSV, and the
 * server sniffs the bytes anyway. `null` means send it.
 *
 * The size bound is the **chunked** cap, not the single-request one: anything over 100 MB is
 * uploaded in chunks rather than rejected, so rejecting it here would refuse a file the app
 * can perfectly well send.
 */
export function validateFileBeforeUpload(file: Pick<File, 'name' | 'size'>): string | null {
  if (file.size > MAX_CHUNKED_MEETING_FILE_SIZE_BYTES) {
    return SIZE_MESSAGE;
  }

  if (file.size === 0) {
    return EMPTY_MESSAGE;
  }

  const name = file.name.trim();

  if (name.length === 0 || name.length > MAX_MEETING_FILE_NAME_LENGTH || /[/\\]/.test(name)) {
    return NAME_MESSAGE;
  }

  if (!MEETING_FILE_ACCEPT.includes(extensionOf(name))) {
    return TYPE_MESSAGE;
  }

  return null;
}

/** The picker's `accept` attribute, derived from the same list the server checks against. */
export function acceptAttribute(): string {
  return MEETING_FILE_ACCEPT.join(',');
}

/** Whether the list should keep polling: any file the worker has not finished with. */
export function isProcessing(files: ReadonlyArray<Pick<MeetingFile, 'status'>>): boolean {
  return files.some(({ status }) => status === 'uploaded' || status === 'processing');
}

/**
 * Newest first, ties on `id` descending — the API's own order, restated for the same reason
 * `latestMeetings` re-sorts: the signature cannot promise an order, and a prepended upload
 * must land where a refetch would put it.
 */
export function sortNewestFirst(files: ReadonlyArray<MeetingFile>): MeetingFile[] {
  return files.toSorted((a, b) => {
    const byInstant = Date.parse(b.createdAt) - Date.parse(a.createdAt);

    return byInstant !== 0 ? byInstant : b.id.localeCompare(a.id);
  });
}
