import type { MeetingDigest } from '@repo/shared';

/**
 * A meeting's digest changed, and the write that changed it is already committed.
 *
 * Published on the in-process `EventBus` by `MeetingDigestAnnouncer` and by nothing else:
 * after a request, after a deleted file changed anything, and after each of the worker's
 * writes that landed. A write that lost its claim changed nothing, so it announces nothing.
 *
 * **It carries the digest as `GET /api/meetings/:id/digest` answers it** — read after the
 * write, by the code that route runs — and not the row or a diff: what a digest shows
 * depends on which recordings are transcribed now, which no write to the row knows.
 *
 * **`digest.version` is what orders it.** Two writes announced by two actors are published
 * as each one's read returns, which need not be the order they committed in, and an event
 * may describe a write later than the one that caused it. A subscriber keeps the higher
 * version of two — an event against an event, or against a fetch — and so needs none of the
 * hand-over machinery `MeetingFileChangedEvent` has for lacking one.
 */
export class MeetingDigestChangedEvent {
  constructor(
    readonly meetingId: string,
    readonly digest: MeetingDigest,
  ) {}
}
