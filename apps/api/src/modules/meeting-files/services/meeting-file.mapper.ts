import type { MeetingFile, MeetingFileStatus } from '@repo/shared';
import { MAX_MEETING_FILE_NAME_LENGTH } from '@repo/shared';

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
}

/**
 * Row → wire shape. Omits everything the worker owns (`storageKey`, `checksum`, `attempts`,
 * `leasedUntil`, `deletedAt`, `purgedAt`); the optional fields are absent rather than null so
 * the JSON matches the shared interface exactly.
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
    createdAt: record.createdAt.toISOString(),
    ...(record.processedAt !== null ? { processedAt: record.processedAt.toISOString() } : {}),
  };
}

export function thumbnailPathOf(meetingId: string, fileId: string): string {
  return `/meetings/${meetingId}/files/${fileId}/thumbnail`;
}

/** Where the object lives under the storage root. Opaque: never the user's name. */
export function transcriptPathOf(meetingId: string, fileId: string): string {
  return `/meetings/${meetingId}/files/${fileId}/transcript`;
}

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
