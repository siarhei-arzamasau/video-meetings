/**
 * Gives up on a session. The chunks are not removed here — expiring the row is what hands
 * them to the worker, which is the one place that removes a chunk tree.
 */
export class AbortUploadCommand {
  constructor(
    readonly userId: string,
    readonly meetingId: string,
    readonly uploadId: string,
  ) {}
}
