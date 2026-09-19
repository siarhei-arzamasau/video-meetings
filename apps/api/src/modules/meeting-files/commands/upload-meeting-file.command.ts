/**
 * Stores the bytes at `tempPath` as a file of the meeting, under the display name
 * `originalName`. The handler owns `tempPath` from here: it is moved into place or removed.
 */
export class UploadMeetingFileCommand {
  constructor(
    readonly userId: string,
    readonly meetingId: string,
    readonly originalName: string,
    readonly tempPath: string,
    readonly size: number,
  ) {}
}
