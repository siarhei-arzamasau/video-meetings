/**
 * One dial for every wait in the browser suite.
 *
 * **Why it exists.** Almost every spec here waits on the same chain: the upload lands, the
 * API's in-process worker claims the row on its next 250 ms poll, a step runs, the transition
 * commits, an event is published, the page applies it, React renders. Instrumenting the API
 * during a failing run showed that chain finishing in about a second — the worker was never
 * idle while a row was claimable, and every transition was published with a subscriber
 * attached — while the page's assertion still timed out at fifteen. What differed was the
 * machine: the same suite that finishes in 47 seconds and passes finishes in 1.4 minutes and
 * fails two or three of these waits, and the failing test passes on its own every time.
 *
 * So the waits are not measuring the product, they are measuring how much of this laptop the
 * suite was given. That is not something a spec can assert about, and picking a bigger number
 * for each `expect` would bury the judgement in twenty-five literals that nobody could raise
 * together later.
 *
 * **What to do with it.** Leave it alone on a machine that is doing nothing else. On one that
 * is — a laptop with containers and other agents on it, or a CI box sharing a runner —
 * `E2E_TIMEOUT_SCALE=2` doubles every wait in the suite and costs nothing when the page is
 * quick, because these are ceilings and not sleeps.
 *
 * **It is not a licence to make a real failure wait longer.** A wait that only passes at a
 * high scale is a wait that found something: the pipeline genuinely is slow, or a row is
 * genuinely stuck. Raise the scale to get a signal out of a loaded machine, not to get a red
 * suite to stop being red.
 */
const scale = Number(process.env['E2E_TIMEOUT_SCALE'] ?? 1);

/** Guards against a typo turning every ceiling into zero, or into an hour. */
const SAFE_SCALE = Number.isFinite(scale) && scale >= 1 && scale <= 20 ? scale : 1;

/** A ceiling in milliseconds, stretched for the machine the suite is running on. */
export function scaled(ms: number): number {
  return Math.round(ms * SAFE_SCALE);
}
