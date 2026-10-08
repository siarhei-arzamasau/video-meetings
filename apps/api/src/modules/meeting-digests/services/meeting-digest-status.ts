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
 * | _(none)_, `READY`, `FAILED` → `QUEUED` | `MeetingDigestRepository.request`                 |
 * | `QUEUED` → `GENERATING`                | the claim, which also re-claims a lapsed lease    |
 * | `GENERATING` → `READY`                 | `complete`, the request it was claimed for intact |
 * | `GENERATING` → `FAILED`                | `fail`, likewise                                  |
 * | `GENERATING` → _(none)_                | `clear`, likewise: nothing was left to generate   |
 * |                                        | from                                              |
 * | `GENERATING` → `QUEUED`                | any of those three after another request; and     |
 * |                                        | `release`, a graceful shutdown's                  |
 *
 * `request` on a row that is `QUEUED` or `GENERATING` changes no status: it moves the
 * revision, which is what turns the generation under way into "one more after it".
 */
export const DigestStatus = {
  QUEUED: 'QUEUED',
  GENERATING: 'GENERATING',
  READY: 'READY',
  FAILED: 'FAILED',
} as const;

export type DigestStatus = (typeof DigestStatus)[keyof typeof DigestStatus];
