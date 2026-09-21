/** What a caught `unknown` says, for a log line. Anything may be thrown, so anything that is
 *  not an `Error` is stringified rather than assumed to have a `message`. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
