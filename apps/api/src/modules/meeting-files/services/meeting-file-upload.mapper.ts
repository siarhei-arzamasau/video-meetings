import type { MeetingFileUpload } from '@repo/shared';

/**
 * The stored session, spelled out so the mapper is unit-testable without the generated
 * client. The Prisma model satisfies it structurally.
 */
export interface MeetingFileUploadRecord {
  id: string;
  meetingId: string;
  uploaderId: string;
  name: string;
  size: number;
  chunkSize: number;
  chunkCount: number;
  receivedChunks: number[];
  attempts: number;
  leasedUntil: Date | null;
  createdAt: Date;
  expiresAt: Date;
  purgedAt: Date | null;
}

/** What creating a session writes. Everything else takes its default. */
export interface NewMeetingFileUpload {
  meetingId: string;
  uploaderId: string;
  name: string;
  size: number;
  chunkSize: number;
  chunkCount: number;
  expiresAt: Date;
}

/**
 * Row → wire shape. Omits what the module owns: `uploaderId` (the session is only ever read
 * by its owner, so it would say nothing), `attempts`, `leasedUntil`, and `purgedAt`.
 *
 * `receivedChunks` is sorted here as well as in the update that writes it. The contract says
 * ascending, and a caller that resumes from `Math.max(...)` must not depend on which of the
 * two places kept the promise.
 */
export function toMeetingFileUpload(record: MeetingFileUploadRecord): MeetingFileUpload {
  return {
    id: record.id,
    meetingId: record.meetingId,
    name: record.name,
    size: record.size,
    chunkSize: record.chunkSize,
    chunkCount: record.chunkCount,
    receivedChunks: [...record.receivedChunks].toSorted((a, b) => a - b),
    createdAt: record.createdAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
  };
}

/** How many chunks a file of `size` is sent in. At least one, since a session needs bytes. */
export function chunkCountOf(size: number, chunkSize: number): number {
  return Math.ceil(size / chunkSize);
}

/**
 * The exact length the chunk at `index` must have: `chunkSize` for every chunk but the last,
 * and the remainder for it. The server derives it from the session rather than believing the
 * request, which is what makes a chunk that arrived truncated a 400 instead of a file with a
 * hole in it.
 */
export function chunkLengthOf(size: number, chunkSize: number, index: number): number {
  const last = chunkCountOf(size, chunkSize) - 1;

  return index === last ? size - chunkSize * last : chunkSize;
}

/** The canonical decimal form, the same one the storage key accepts. */
const CHUNK_INDEX = /^(0|[1-9]\d{0,8})$/;

/**
 * The index a path segment spells, or `null` when it spells none — a word, a negative, a
 * leading zero. Whether a session has that many chunks is the caller's to ask.
 */
export function parseChunkIndex(segment: string): number | null {
  return CHUNK_INDEX.test(segment) ? Number(segment) : null;
}

/** Where one chunk lives under the storage root. Opaque, like `storageKeyOf`. */
export function chunkKeyOf(uploadId: string, index: number): string {
  return `uploads/${uploadId}/${String(index)}`;
}
