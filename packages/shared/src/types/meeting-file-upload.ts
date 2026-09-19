import type { Meeting } from './meeting';

/**
 * An upload session: the record of a large file arriving in chunks, before any `MeetingFile`
 * exists. Created by `POST /api/meetings/:id/files/uploads`, read back by the status route,
 * and gone once `complete` has turned it into a `MeetingFile`.
 *
 * No `MeetingFile` exists while a session does — that is the whole point of the separate
 * table. A session is never listed with the meeting's files.
 */
export interface MeetingFileUpload {
  id: string;
  meetingId: Meeting['id'];
  name: string;
  size: number;
  chunkSize: number;
  chunkCount: number;
  /** Indexes the server has durably stored, ascending. */
  receivedChunks: ReadonlyArray<number>;
  /** ISO 8601 instants, UTC. */
  createdAt: string;
  expiresAt: string;
}

/**
 * The cap on a chunked upload, 1 GiB. Deliberately under 2 GiB: `MeetingFile.size` is an
 * `Int`, and raising the cap past that bound is the `BigInt` migration, not a constant here.
 */
export const MAX_CHUNKED_MEETING_FILE_SIZE_BYTES = 1024 ** 3;

/**
 * The chunk size, fixed by the server and returned when a session is created. The client
 * never chooses it: every chunk but the last must be exactly this long, which is what lets
 * the server check a chunk's length without trusting anything the client says about it.
 */
export const MEETING_FILE_CHUNK_SIZE_BYTES = 8 * 1024 * 1024;

/**
 * The size rejection for the chunked path, stated once here for the same reason
 * `MEETING_FILE_SIZE_MESSAGE` is: the web app shows it before the round trip and the API
 * sends it, and a rejection must read the same whichever side made it.
 */
export const MEETING_FILE_CHUNKED_SIZE_MESSAGE = 'Files must be 1 GB or smaller.';
