/**
 * Sends a `failed` transcription back to the queue. The file itself is `ready` throughout:
 * this is the transcription's retry, not the file's — that one is `RetryMeetingFileCommand`.
 */
export class RetryMeetingFileTranscriptionCommand {
  constructor(
    readonly userId: string,
    readonly meetingId: string,
    readonly fileId: string,
  ) {}
}
