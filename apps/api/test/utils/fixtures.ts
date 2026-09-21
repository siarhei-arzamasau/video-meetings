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

/**
 * The user's own record. A literal `me`, never an id: a route that took one would be a
 * route that could be pointed at somebody else, and `users-me.e2e-spec.ts` asserts that no
 * such route answers at all.
 */
export const USERS_ME_URL = '/api/users/me';

/** The caller's own credential. A literal path for the same reason `users/me` is one. */
export const CHANGE_PASSWORD_URL = '/api/auth/password';

/** The caller's own picture. `me` again, so no route here can be pointed at anyone else. */
export const AVATAR_URL = '/api/users/me/avatar';

export function meetingFilesUrl(meetingId: string): string {
  return `${MEETINGS_URL}/${meetingId}/files`;
}

export function meetingFileEventsUrl(meetingId: string): string {
  return `${meetingFilesUrl(meetingId)}/events`;
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

/**
 * The display name contract in `@repo/shared`, restated for the same reason as
 * `MAX_TITLE_LENGTH`: importing it would make the test agree with whatever the constant
 * becomes, so relaxing a bound or rewording the message would quietly stay green. The
 * dash is an en dash, as the shared string has it.
 */
export const MAX_DISPLAY_NAME_LENGTH = 80;
export const DISPLAY_NAME_MESSAGE = 'Your display name must be 1\u201380 characters.';

/** The shortest password the API accepts. One character less must be a 400. */
export const MIN_PASSWORD_LENGTH = 8;

/** The longest. Restated rather than imported, as everything else here is. */
export const MAX_PASSWORD_LENGTH = 256;

/**
 * The change-password copy from `@repo/shared`, restated for the same reason as
 * `DISPLAY_NAME_MESSAGE`: the browser tells a wrong current password from an expired token by
 * this exact sentence, so a spec that spelt it out of the constant could not notice the day
 * the wording drifts.
 */
export const CURRENT_PASSWORD_MESSAGE = 'That is not your current password.';
export const PASSWORD_UNCHANGED_MESSAGE =
  'Your new password must be different from your current one.';

/** A second password for the rotation specs, distinct from `PASSWORD`. */
export const NEW_PASSWORD = 'a-different-battery-43';

/**
 * The avatar contract from `@repo/shared`, restated for the reason everything else here is:
 * relaxing a bound or rewording a message must fail a test rather than quietly pass one.
 */
export const MAX_AVATAR_SIZE_BYTES = 5 * 1024 * 1024;
export const AVATAR_SIZE_PIXELS = 256;
export const AVATAR_CONTENT_TYPE = 'image/webp';
export const AVATAR_SIZE_MESSAGE = 'Your picture must be 5 MB or smaller.';
export const AVATAR_TYPE_MESSAGE = 'Your picture must be a PNG, JPEG, or WebP image.';
export const AVATAR_EMPTY_MESSAGE = 'The file is empty.';
export const AVATAR_UNREADABLE_MESSAGE = 'That image could not be read. Try a different file.';
export const AVATAR_DIMENSIONS_MESSAGE =
  'Your picture has too many pixels. Use an image of 64 megapixels or smaller.';

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
