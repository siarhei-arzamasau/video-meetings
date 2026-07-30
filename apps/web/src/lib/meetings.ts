import type { Meeting } from '@repo/shared';

/** How many meetings the home page's "Latest meetings" list shows. */
export const LATEST_MEETINGS_COUNT = 3;

/**
 * The most recently scheduled meetings, latest first.
 *
 * Re-sorts rather than reversing what the API sent, and that is not distrust of the endpoint.
 * The signature cannot state "must arrive ascending", so a helper that relied on it would be
 * one plausible edit away — a filter, a merge, a second endpoint, a pagination parameter — from
 * returning three wrong meetings that look exactly like three right ones. The cost is sorting
 * an already-sorted list of one person's meetings, which is nothing.
 *
 * `toSorted`, not `sort`: the argument is the array held in component state, and returning a new
 * array is a property of the method rather than of remembering to copy first.
 */
export function latestMeetings(
  meetings: ReadonlyArray<Meeting>,
  limit: number = LATEST_MEETINGS_COUNT,
): Meeting[] {
  return meetings.toSorted(byScheduledAtDescending).slice(0, limit);
}

/**
 * Ties break on `id` ascending — the same direction as the API's
 * `orderBy: [{ scheduledAt }, { id }]`, so two meetings at one instant keep one relative order
 * everywhere in the app rather than acquiring a second convention here.
 *
 * `Date.parse`, not a string comparison: the shared type promises a UTC instant but not one
 * spelling of it, and `…T09:00Z` sorts before `…T09:00:00.000Z` lexicographically while naming
 * the same moment.
 */
function byScheduledAtDescending(a: Meeting, b: Meeting): number {
  const byInstant = Date.parse(b.scheduledAt) - Date.parse(a.scheduledAt);

  return byInstant !== 0 ? byInstant : a.id.localeCompare(b.id);
}
