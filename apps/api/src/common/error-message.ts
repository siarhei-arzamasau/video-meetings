/** What a caught `unknown` says, for a log line. Anything may be thrown, so anything that is
 *  not an `Error` is stringified rather than assumed to have a `message`. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Far more wrapping than any error here has; what it bounds is a `cause` that names itself. */
const MAX_CAUSE_DEPTH = 5;

/**
 * A caught `unknown` for the stack argument of `Logger.error`: its stack, and under it the
 * stack of every `cause` it was wrapped around.
 *
 * `Error.stack` alone stops at the wrapper. An error thrown as
 * `new InternalServerErrorException(MESSAGE, { cause })` then logs the sentence this code
 * chose and drops the `ENOENT`, the constraint, or the SDK's own failure that the `cause` was
 * attached to keep — which is the half a person reading the log needed.
 */
export function describeError(error: unknown): string {
  const lines: string[] = [];
  let current: unknown = error;

  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && current !== undefined; depth += 1) {
    const described =
      current instanceof Error ? (current.stack ?? current.message) : String(current);

    lines.push(depth === 0 ? described : `Caused by: ${described}`);
    current = current instanceof Error ? current.cause : undefined;
  }

  return lines.join('\n');
}
