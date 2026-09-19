/**
 * Opens a chunked upload session for a file the client is about to send in pieces. Carries
 * only what the client declares — the name and the total size — because nothing else about
 * the file is knowable until its bytes have arrived.
 */
export class CreateUploadCommand {
  constructor(
    readonly userId: string,
    readonly meetingId: string,
    readonly originalName: string,
    readonly size: number,
  ) {}
}
