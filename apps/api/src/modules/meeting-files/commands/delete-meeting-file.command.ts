/** Soft-deletes a file: the record moves to `deleted`, the bytes are the worker's to purge. */
export class DeleteMeetingFileCommand {
  constructor(
    readonly userId: string,
    readonly meetingId: string,
    readonly fileId: string,
  ) {}
}
