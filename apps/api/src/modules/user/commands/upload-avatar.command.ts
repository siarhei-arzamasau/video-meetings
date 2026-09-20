/**
 * Carries the caller's id and the path multer wrote the upload to. The bytes are on disk, not
 * in the command: an avatar is small, but a command that carried a buffer would be a command
 * nothing could dispatch without first holding the whole file in memory.
 *
 * The handler **owns the temp file from here** and removes it on every exit, successful or
 * not — the interceptor's own cleanup is the net for what fails before the handler runs.
 */
export class UploadAvatarCommand {
  constructor(
    readonly userId: string,
    readonly tempPath: string,
    /** Bytes, as multer measured them. Only an empty file is decided on this. */
    readonly size: number,
  ) {}
}
