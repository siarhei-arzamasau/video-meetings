/**
 * Turns a session whose chunks have all arrived into a `MeetingFile`. Carries no bytes: what
 * is to be assembled is already on disk, and the session says which pieces and in what order.
 */
export class CompleteUploadCommand {
  constructor(
    readonly userId: string,
    readonly meetingId: string,
    readonly uploadId: string,
  ) {}
}
