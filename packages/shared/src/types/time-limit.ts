const SECONDS_PER_MINUTE = 60;

/**
 * A deployment's time limit as a failure reason names it: `12-minute` for a whole number of
 * minutes, `90-second` otherwise. One spelling, for every reason that names a limit.
 */
export function describeTimeLimit(limitSeconds: number): string {
  return limitSeconds % SECONDS_PER_MINUTE === 0
    ? `${String(limitSeconds / SECONDS_PER_MINUTE)}-minute`
    : `${String(limitSeconds)}-second`;
}
