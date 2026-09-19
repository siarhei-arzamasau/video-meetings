/**
 * Stores one chunk of an upload session. `body` is the raw request body — at most one chunk,
 * which the route's body parser enforces before this exists.
 */
export class StoreChunkCommand {
  constructor(
    readonly userId: string,
    readonly meetingId: string,
    readonly uploadId: string,
    readonly index: number,
    readonly body: Buffer,
  ) {}
}
