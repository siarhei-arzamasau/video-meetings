import type { Meeting } from './meeting';
import type { User } from './user';

export const MEETING_FILE_STATUSES = [
  'uploaded',
  'processing',
  'ready',
  'failed',
  'deleted',
] as const;

export type MeetingFileStatus = (typeof MEETING_FILE_STATUSES)[number];

/** A file attached to a meeting, as `GET /api/meetings/:id/files` reports it. */
export interface MeetingFile {
  id: string;
  meetingId: Meeting['id'];
  uploaderId: User['id'];
  /** The user's filename after trimming and separator rejection. Display only; never a path. */
  name: string;
  /** Server-sniffed media type. */
  contentType: string;
  /** Bytes. */
  size: number;
  status: MeetingFileStatus;
  /** Present only when `status` is `failed`. Safe to render. */
  failureReason?: string;
  /** Present when a thumbnail exists; a relative API path. */
  thumbnailPath?: string;
  /** ISO 8601 instants, UTC. */
  createdAt: string;
  processedAt?: string;
}

export const MAX_MEETING_FILE_SIZE_BYTES = 100 * 1024 * 1024;
export const MAX_MEETING_FILES = 50;
/** Characters, after trimming. Matches the longest name most filesystems accept. */
export const MAX_MEETING_FILE_NAME_LENGTH = 255;

/**
 * The PRD's upload copy, stated once. The API sends these as its error messages and the web
 * app shows the same ones for the checks it runs before a round trip, so a rejection reads
 * the same whichever side made it. `MEETING_FILE_PROCESSING_FAILED_MESSAGE` is the worker's
 * generic `failureReason` and the web app's fallback for a `failed` row that carries none.
 */
export const MEETING_FILE_SIZE_MESSAGE = 'Files must be 100 MB or smaller.';
export const MEETING_FILE_TYPE_MESSAGE = 'That file type is not supported.';
export const MEETING_FILE_EMPTY_MESSAGE = 'The file is empty';
export const MEETING_FILE_NAME_MESSAGE =
  'The file name must be 1–255 characters and contain no path separators';
export const MEETING_FILE_PROCESSING_FAILED_MESSAGE =
  'Processing failed. You can still download the file.';

/**
 * Media types the server stores, and the extensions the picker offers for each. One table, so
 * the `accept` attribute and the server's check are derived from the same list and cannot
 * disagree. Sniffing is by content on the server: an extension here never decides a type, it
 * only tells the browser which files to show in the dialog.
 *
 * HTML and SVG are deliberately absent: a stored one served inline is a stored XSS.
 */
const MEETING_FILE_TYPES: ReadonlyArray<readonly [mediaType: string, extensions: string[]]> = [
  ['application/pdf', ['.pdf']],
  ['image/png', ['.png']],
  ['image/jpeg', ['.jpg', '.jpeg']],
  ['image/gif', ['.gif']],
  ['image/webp', ['.webp']],
  ['video/mp4', ['.mp4', '.m4v']],
  ['video/webm', ['.webm']],
  ['audio/mpeg', ['.mp3']],
  ['audio/mp4', ['.m4a']],
  // `file-type` reports WAV as `audio/vnd.wave`; the API's sniffer maps it to `audio/wav` so
  // the allow-list holds the name clients expect.
  ['audio/wav', ['.wav']],
  ['text/plain', ['.txt']],
  ['text/markdown', ['.md', '.markdown']],
  ['text/csv', ['.csv']],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', ['.docx']],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ['.xlsx']],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', ['.pptx']],
];

/** The media types `POST /api/meetings/:id/files` accepts, as the server sniffs them. */
export const MEETING_FILE_ALLOWED_TYPES: ReadonlyArray<string> = MEETING_FILE_TYPES.map(
  ([mediaType]) => mediaType,
);

/**
 * Extensions for the file picker's `accept` attribute. Media types alone are not enough there:
 * browsers filter `text/markdown` and `text/csv` inconsistently, and an extension list is what
 * every one of them honours.
 */
export const MEETING_FILE_ACCEPT: ReadonlyArray<string> = MEETING_FILE_TYPES.flatMap(
  ([, extensions]) => extensions,
);
