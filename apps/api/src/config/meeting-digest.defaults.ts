/**
 * The meeting digest's time limit, and the measurements it and the transcript cap
 * (`MAX_DIGEST_TRANSCRIPT_CHARACTERS`, in the module's constants) were set from. Stated here,
 * beside the default, for the reason the transcription's are: a limit is a measurement, and
 * the next person to change one should re-measure rather than reason about it.
 *
 * Measured on 2026-10-08 through `MeetingDigestGenerator` against `claude-sonnet-5-5`, with
 * Claude Agent SDK 0.3.292, by `pnpm --filter=@repo/api test:live` — which prints these
 * columns — and its opt-in measurements (`test/meeting-digest-measure.live-spec.ts`). Seconds
 * are the whole call, the Claude Code process's start included; cost is what the SDK
 * reported. The first five rows are the range over two runs, the cheaper end being the run
 * that found the instructions already cached; the rest were run once each.
 *
 * | Transcripts                                        | Tokens in | Tokens out | Seconds   | Cost            |
 * | -------------------------------------------------- | --------- | ---------- | --------- | --------------- |
 * | The reference, 470 characters                      | 3,037     | 300 – 301  | 3.2 – 3.8 | $0.004 – $0.008 |
 * | The reference in Russian, 426 characters           | 3,070     | 307 – 311  | 3.3 – 3.5 | $0.005 – $0.008 |
 * | No outcomes, 327 characters                        | 3,003     | 205 – 208  | 2.9 – 3.9 | $0.003 – $0.007 |
 * | Two recordings with no speech, 0 characters        | 2,904     | 110        | 2.6       | $0.002 – $0.006 |
 * | Instructions past a closing tag, 923 characters    | 3,182     | 389 – 399  | 4.6 – 4.8 | $0.006 – $0.009 |
 * | Russian, 50,000 characters                         | 24,009    | 375        | 4.7       | $0.086          |
 * | 60 action items and 60 decisions, 8,893 characters | 5,608     | 3,613      | 18.8      | $0.050          |
 * | 50 action items and 50 decisions, 7,413 characters | 4,931 *   | 3,315      | 16.5      | $0.045          |
 * | A long meeting in English, 1,000,000 characters    | 347,178 * | 458        | 10.1      | $0.869          |
 *
 * The two rows marked * were measured before the instructions gained their last three rules,
 * which are 225 tokens: the same call today reads that many more. Nothing below turns on it.
 *
 * What the rows say:
 *
 * - **About 2,900 of every call's tokens are not the transcripts**: the instructions, the
 *   schema, and the SDK's own framing. The row with no speech is that number by itself — two
 *   empty recordings, which are a dozen tokens of tags each.
 * - **English prose is 2.9 characters a token** (the long row: 1,000,000 characters in the
 *   344,500 tokens it has over the 2,700 the instructions then were) **and Russian is 2.4**
 *   (50,000 characters in 24,009 − 2,900 = 21,100 tokens, and the short Russian row agrees:
 *   426 characters in about 180).
 * - **Reading is cheap in time and writing is not.** 344,000 more tokens in cost 6.6 seconds,
 *   19 microseconds each; 3,000 more tokens out cost 13 to 16 seconds, 4.4 to 4.7 milliseconds
 *   each. A generation is as slow as its answer is long, not as its meeting was.
 * - **Input is billed at the cache-write rate.** $0.869 for the long row is $2.50 a million
 *   tokens, not the $2.00 the model lists: Claude Code marks the prompt for Anthropic's
 *   prompt cache, and a one-turn call never reads it back. A generation's cost is therefore
 *   its tokens in at $2.50 a million and its tokens out at $10.
 * - **One row does not fit those rates, and why was not looked into.** The Russian row cost
 *   $0.086 where its tokens make $0.064. Earlier runs showed Claude Code making a small call
 *   of its own to `claude-haiku-4-5` beside some generations, which may be it; a result's
 *   `modelUsage` is where to look.
 * - **A list past its bound is cut, not failed.** Sixty tasks and sixty decisions came back
 *   as fifty and fifty, in one turn, under a summary that says the lists are not complete.
 *
 * **No generation at the cap was run.** The most a prompt can hold is about 869,000 tokens
 * (see the cap), which is $2.17 a call; the long row is 40% of that, and the rest is
 * extrapolated from the two rates, taking the slower one for writing:
 *
 *     2 s to start + 869,000 tokens in × 19 µs + 21,500 tokens out × 4.7 ms ≈ 120 s
 *
 * where 21,500 tokens is an answer at every one of its bounds at once — a 4,000-character
 * summary, fifty action items with owners and fifty decisions of 500 characters each, and
 * the JSON around them — at three characters a token. Twice that is four minutes.
 *
 * The rates are Anthropic's on the day, and they move with load: a deployment that sees
 * digests fail on the limit wants a larger `MEETING_DIGEST_TIMEOUT_SECONDS`, not a retry.
 */
export const DEFAULT_MEETING_DIGEST_TIMEOUT_SECONDS = 240;
