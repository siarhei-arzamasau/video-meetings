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
 * **Every row above was measured before a generation held tools, and none was run again
 * with them.** Since 2026-10-09 a run is handed the meeting's three tools and keeps its
 * tasks before it answers. Measured that day, same model and SDK, one run each, by
 * `test:live` — whose task store is in memory, so a tool call costs no database time:
 *
 * | Transcripts, with tools                       | Tokens in | Tokens out | Seconds | Cost   |
 * | --------------------------------------------- | --------- | ---------- | ------- | ------ |
 * | The reference, two tasks created              | 14,896    | 675        | 6.7     | $0.023 |
 * | The reference again, both tasks already there | 15,283    | 696        | 6.3     | $0.013 |
 * | The reference in Russian                      | 15,102    | 728        | 6.7     | $0.020 |
 * | No outcomes, so no tool call                  | 4,587     | 204        | 2.9     | $0.011 |
 * | Two recordings with no speech                 | 4,490     | 110        | 2.8     | $0.009 |
 * | Instructions past a closing tag               | 15,507    | 842        | 8.2     | $0.022 |
 *
 * - **The tools and their rules are about 1,600 tokens of every call** (4,490 against the
 *   2,904 of the same row above), and a meeting that states no task makes no tool call.
 * - **A meeting with tasks is three requests where there was one**: one to look for the
 *   tasks, one to write them, one to answer, and each reads the whole prompt and the
 *   tools' replies so far. That is the 14,900 tokens — three times a run that calls no
 *   tool, five times what the reference read before there were tools — and about twice
 *   the seconds. The SDK reported `num_turns: 6` for each such run and 2 for the others.
 * - **Nothing here says what fifty tasks cost.** If the model looks and writes in two
 *   rounds, as it did for two, the answer still dominates and the limit below holds; if it
 *   works through them one at a time, a hundred rounds each read the prompt again, and
 *   neither the limit nor `MAX_TOOL_RUN_TURNS` was measured against that.
 *   `MEETING_DIGEST_MEASURE_OUTCOMES` is the run that would say.
 *
 * The rates are Anthropic's on the day, and they move with load: a deployment that sees
 * digests fail on the limit wants a larger `MEETING_DIGEST_TIMEOUT_SECONDS`, not a retry.
 */
export const DEFAULT_MEETING_DIGEST_TIMEOUT_SECONDS = 240;

/**
 * How many times one generation may call the meeting's tools before every further call is
 * refused and the model is told to answer.
 *
 * **Twenty is room, not a measurement.** Keeping a task is two calls, one to look for it and
 * one to write it, so twenty is ten tasks; no run was counted against it. A meeting with
 * more than that gets its digest whole and its tasks in part: the answer is not a tool call
 * and is never refused. What the budget bounds is the cost of a run that keeps calling,
 * since every round of calls reads the whole prompt again.
 *
 * What was measured, on 2026-10-09 by `test:live`, is that the budget holds in both of its
 * halves. **Told its budget, the model plans for it**: the reference with two calls allowed
 * searched for one task, wrote it, and answered with both action items and no call refused
 * — 14,658 tokens in, 6.1 seconds, $0.021. **Told a larger one than its hooks allow, it is
 * held all the same**: with one call let through under instructions that promised twenty,
 * it made one, was refused the next, and answered with the whole digest — 9,756 tokens in,
 * 5.0 seconds, $0.015. Before the instructions named the budget, that second run was the
 * only way a budget showed: one search, and no task written.
 *
 * The sentence that names the budget is about 100 tokens of every call (4,593 for the
 * recordings with no speech, against the 4,490 of the table above), and the hooks
 * themselves none.
 */
export const DEFAULT_MEETING_DIGEST_MAX_TOOL_CALLS = 20;
