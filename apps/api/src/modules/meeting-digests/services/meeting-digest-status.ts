/**
 * A digest's stored status — Prisma's `MeetingDigestStatus`, spelled out so nothing that
 * names one needs the generated client; the model satisfies it structurally.
 *
 * UPPER_CASE, as `.claude/rules/prisma.md` asks of an enum, while the wire vocabulary in
 * `@repo/shared` is lower-case. `meeting-digest.mapper.ts` is the one place that translates.
 *
 * The edges, and who takes each:
 *
 * | Edge                                   | Taken by                                          |
 * | -------------------------------------- | ------------------------------------------------- |
 * | _(none)_, `READY`, `FAILED` → `QUEUED` | `MeetingDigestRepository.request`: a recording    |
 * |                                        | transcribed; and `followDelete`, for a digest     |
 * |                                        | that lost a recording while others are left       |
 * | `QUEUED` → `GENERATING`                | the claim, which also re-claims a lapsed lease    |
 * | `GENERATING` → `READY`                 | `complete`, the request it was claimed for intact |
 * | `GENERATING` → `FAILED`                | `fail`, likewise                                  |
 * | `GENERATING` → _(none)_                | `clear`, likewise: nothing was left to generate   |
 * |                                        | from                                              |
 * | `GENERATING` → `QUEUED`                | any of those three after another request; and     |
 * |                                        | `release` — a graceful shutdown's, and an answer  |
 * |                                        | discarded for a recording deleted meanwhile       |
 * | any → _(none)_                         | `followDelete`: the last transcribed recording    |
 * |                                        | deleted, or a digest that lost a recording while  |
 * |                                        | the setting is off                                |
 *
 * `request` on a row that is `QUEUED` or `GENERATING` changes no status: it moves the
 * revision, which is what turns the generation under way into "one more after it".
 *
 * **`GENERATING` → _(none)_ by a delete does not hang up on the call at once.** Its worker
 * finds the claim gone at the next lease renewal, a third of the lease away at most. One
 * replica runs one loop, so nothing starts meanwhile; with two, a request made in those
 * seconds queues a row the other may claim while the first call is still open. Nothing
 * wrong is stored — every write is conditional on the lease — and one call is paid for and
 * discarded: the lapsed-lease case, reached sooner. The plan's decision 8 has why it stays.
 */
export const DigestStatus = {
  QUEUED: 'QUEUED',
  GENERATING: 'GENERATING',
  READY: 'READY',
  FAILED: 'FAILED',
} as const;

export type DigestStatus = (typeof DigestStatus)[keyof typeof DigestStatus];
