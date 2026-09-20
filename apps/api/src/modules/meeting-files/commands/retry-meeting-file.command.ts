/** Sends a `failed` file back through the pipeline: the explicit retry the PRD reserved. */
export class RetryMeetingFileCommand {
  constructor(
    readonly userId: string,
    readonly meetingId: string,
    readonly fileId: string,
  ) {}
}
