import type { MeetingFile, MeetingFileStatus, MeetingFileTranscriptionStatus } from '@repo/shared';
import { MAX_MEETING_FILE_NAME_LENGTH } from '@repo/shared';

import { TranscriptionStatus } from './meeting-file-transcription-status';

/**
 * The stored row, spelled out so `toMeetingFile` is unit-testable without the generated
 * client. The Prisma model satisfies it structurally.
 */
export interface MeetingFileRecord {
  id: string;
  meetingId: string;
  uploaderId: string;
  name: string;
  contentType: string;
  size: number;
  storageKey: string;
  checksum: string | null;
  thumbnailKey: string | null;
  transcriptKey: string | null;
  status: MeetingFileStatus;
  failureReason: string | null;
  attempts: number;
  leasedUntil: Date | null;
  createdAt: Date;
  processedAt: Date | null;
  deletedAt: Date | null;
  purgedAt: Date | null;
  transcriptionStatus: TranscriptionStatus | null;
  transcriptionFailureReason: string | null;
  transcriptionAttempts: number;
  transcriptionLeasedUntil: Date | null;
}

/**
 * The stored transcription status in the wire's words: UPPER_CASE in the database, lower-case
 * in `@repo/shared`. The one place that translates — a `Record`, so a status added to either
 * side without its word here does not compile.
 */
const WIRE_TRANSCRIPTION_STATUS: Record<TranscriptionStatus, MeetingFileTranscriptionStatus> = {
  [TranscriptionStatus.QUEUED]: 'queued',
  [TranscriptionStatus.TRANSCRIBING]: 'transcribing',
  [TranscriptionStatus.TRANSCRIBED]: 'transcribed',
  [TranscriptionStatus.FAILED]: 'failed',
};

/**
 * Row → wire shape. Omits everything the workers own (`storageKey`, `checksum`, `attempts`,
 * `leasedUntil`, `deletedAt`, `purgedAt`, and the transcription claim's count and lease); the
 * optional fields are absent rather than null so the JSON matches the shared interface exactly.
 */
export function toMeetingFile(record: MeetingFileRecord): MeetingFile {
  return {
    id: record.id,
    meetingId: record.meetingId,
    uploaderId: record.uploaderId,
    name: record.name,
    contentType: record.contentType,
    size: record.size,
    status: record.status,
    // Only when failed: a stale reason on a row that was retried to `ready` must not show.
    ...(record.status === 'failed' && record.failureReason !== null
      ? { failureReason: record.failureReason }
      : {}),
    ...(record.thumbnailKey !== null
      ? { thumbnailPath: thumbnailPathOf(record.meetingId, record.id) }
      : {}),
    ...(record.transcriptKey !== null
      ? { transcriptPath: transcriptPathOf(record.meetingId, record.id) }
      : {}),
    ...transcriptionOf(record),
    createdAt: record.createdAt.toISOString(),
    ...(record.processedAt !== null ? { processedAt: record.processedAt.toISOString() } : {}),
  };
}

/**
 * Nothing at all for a row that was never queued, and the reason only when failed: one left
 * behind on a transcription that was queued again must not show.
 */
function transcriptionOf(
  record: MeetingFileRecord,
): Pick<MeetingFile, 'transcriptionStatus' | 'transcriptionFailureReason'> {
  if (record.transcriptionStatus === null) {
    return {};
  }

  const failed = record.transcriptionStatus === TranscriptionStatus.FAILED;

  return {
    transcriptionStatus: WIRE_TRANSCRIPTION_STATUS[record.transcriptionStatus],
    ...(failed && record.transcriptionFailureReason !== null
      ? { transcriptionFailureReason: record.transcriptionFailureReason }
      : {}),
  };
}

export function thumbnailPathOf(meetingId: string, fileId: string): string {
  return `/meetings/${meetingId}/files/${fileId}/thumbnail`;
}

export function transcriptPathOf(meetingId: string, fileId: string): string {
  return `/meetings/${meetingId}/files/${fileId}/transcript`;
}

/** Where the object lives under the storage root. Opaque: never the user's name. */
export function storageKeyOf(meetingId: string, fileId: string): string {
  return `${meetingId}/${fileId}`;
}

export function thumbnailKeyOf(storageKey: string): string {
  return `${storageKey}.thumb.webp`;
}

export function transcriptKeyOf(storageKey: string): string {
  return `${storageKey}.transcript.txt`;
}

/** C0 controls and DEL: none of them belong in a name that is rendered or put in a header. */
function hasControlCharacter(name: string): boolean {
  for (const character of name) {
    const code = character.codePointAt(0) ?? 0;

    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }

  return false;
}

/**
 * The display name rule: trimmed, 1–255 characters, no path separators, no control characters.
 * `null` means "reject with the name message". The name is display only — the object's path
 * is the storage key — so this is about what is safe to render and to put in a
 * `Content-Disposition` header, not about the filesystem.
 */
export function normaliseFileName(raw: string): string | null {
  const name = raw.trim();

  if (name.length === 0 || name.length > MAX_MEETING_FILE_NAME_LENGTH) {
    return null;
  }

  if (name.includes('/') || name.includes('\\') || hasControlCharacter(name)) {
    return null;
  }

  return name;
}
