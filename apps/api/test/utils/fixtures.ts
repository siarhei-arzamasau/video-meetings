/**
 * Signing secret and lifetime every e2e run uses, applied to the environment by
 * `test/setup-env.ts` before anything imports the application.
 */
export const TEST_JWT_SECRET = 'e2e-only-secret-do-not-use-in-production';
export const TEST_JWT_EXPIRES_IN_SECONDS = 3600;

export const REGISTER_URL = '/api/auth/register';
export const LOGIN_URL = '/api/auth/login';
export const ME_URL = '/api/auth/me';
export const MEETINGS_URL = '/api/meetings';

export function meetingFilesUrl(meetingId: string): string {
  return `${MEETINGS_URL}/${meetingId}/files`;
}

export function meetingFileUrl(meetingId: string, fileId: string): string {
  return `${meetingFilesUrl(meetingId)}/${fileId}`;
}

export function meetingFileRetryUrl(meetingId: string, fileId: string): string {
  return `${meetingFileUrl(meetingId, fileId)}/retry`;
}

export function meetingFileTranscriptUrl(meetingId: string, fileId: string): string {
  return `${meetingFileUrl(meetingId, fileId)}/transcript`;
}

export function meetingFileContentUrl(meetingId: string, fileId: string): string {
  return `${meetingFileUrl(meetingId, fileId)}/content`;
}

export function meetingFileThumbnailUrl(meetingId: string, fileId: string): string {
  return `${meetingFileUrl(meetingId, fileId)}/thumbnail`;
}

export function meetingFileUploadsUrl(meetingId: string): string {
  return `${meetingFilesUrl(meetingId)}/uploads`;
}

export function meetingFileUploadUrl(meetingId: string, uploadId: string): string {
  return `${meetingFileUploadsUrl(meetingId)}/${uploadId}`;
}

export function meetingFileChunkUrl(meetingId: string, uploadId: string, index: number): string {
  return `${meetingFileUploadUrl(meetingId, uploadId)}/chunks/${String(index)}`;
}

export function meetingFileCompleteUrl(meetingId: string, uploadId: string): string {
  return `${meetingFileUploadUrl(meetingId, uploadId)}/complete`;
}

/** Provider token the worker is registered under, so the e2e spec can reach `drain()`. */
export const MEETING_FILE_WORKER_TOKEN = 'MEETING_FILE_WORKER';

/**
 * The transcription port's token, restated here for the same reason: a spec binds a fake to
 * it without importing anything from the module under test.
 */
export const TRANSCRIPTION_PROVIDER_TOKEN = 'TRANSCRIPTION_PROVIDER';

export const EMAIL = 'ada@example.com';
export const PASSWORD = 'correct-horse-battery-42';

/** Second and third accounts, for the cases that need someone other than `EMAIL` to exist. */
export const OTHER_EMAIL = 'grace@example.com';
export const THIRD_EMAIL = 'charles@example.com';

/** Mirrors `CreateMeetingDto`. Declared here, not imported, so a relaxed bound fails a test. */
export const MAX_TITLE_LENGTH = 200;
export const MAX_PARTICIPANTS = 100;

/**
 * Mirrors the meeting file contract in `@repo/shared`. Restated rather than imported, for the
 * same reason as `MAX_TITLE_LENGTH`: a relaxed bound must fail a test.
 */
export const MAX_MEETING_FILE_SIZE_BYTES = 100 * 1024 * 1024;
export const MAX_MEETING_FILES = 50;
export const MAX_MEETING_FILE_NAME_LENGTH = 255;

/** The chunked upload contract, restated for the same reason. */
export const MAX_CHUNKED_MEETING_FILE_SIZE_BYTES = 1024 ** 3;
export const MEETING_FILE_CHUNK_SIZE_BYTES = 8 * 1024 * 1024;

/**
 * The storage root `setup-env.ts` created for this run. Read at call time, not at import: the
 * setup file runs first, but a module-level constant here would freeze whatever `process.env`
 * held when this module happened to be evaluated.
 */
export function meetingFilesDir(): string {
  const dir = process.env['MEETING_FILES_DIR'];

  if (dir === undefined || dir === '') {
    throw new Error('MEETING_FILES_DIR is not set — is test/setup-env.ts in setupFiles?');
  }

  return dir;
}

/** The shortest password the API accepts. One character less must be a 400. */
export const MIN_PASSWORD_LENGTH = 8;

/** RFC 5321's maximum forward path. Anything longer must be a 400, not a 500. */
export const MAX_EMAIL_LENGTH = 254;

/** Upper bound on token lifetime. Guards against a token that expires so late it never does. */
export const MAX_TOKEN_LIFETIME_SECONDS = 30 * 24 * 60 * 60;

/**
 * bcrypt silently truncates at 72 bytes, which makes every password sharing a 72-byte
 * prefix the same credential. These two must never authenticate each other.
 */
export const LONG_PASSWORD = `${'a'.repeat(72)}-tail-one`;
export const LONG_PASSWORD_SAME_PREFIX = `${'a'.repeat(72)}-tail-two`;
