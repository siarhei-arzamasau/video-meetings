/**
 * The viewer's own locale and time zone, resolved once. Constructing an `Intl.DateTimeFormat`
 * is the expensive part, and formatting one instant per row would build one formatter per row.
 *
 * No zone name in the output: `dateStyle: 'medium'` with `timeStyle: 'short'` keeps a list row
 * short, and the zone is the reader's own, which they do not need told to them.
 */
const MEETING_TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/**
 * An ISO instant as a date and time, in the reader's locale and zone.
 *
 * Not a pinned locale: a meeting time is read by the person who has to be there, and rendering
 * `7/30/2026` to someone who reads `30/07/2026` is a misread date, not a cosmetic difference.
 * Tests inject their own formatter instead — determinism is the test's problem, and not a
 * reason to show every reader the same wrong format. That is the only thing the parameter is
 * for; production always takes the default.
 *
 * Formatting in the reader's zone is safe here only because the home page fetches after mount,
 * so nothing server-rendered formats a date and there is no server string for the client's to
 * disagree with. Server-render that page and every one of these becomes a hydration mismatch.
 */
export function formatMeetingTime(
  iso: string,
  format: Intl.DateTimeFormat = MEETING_TIME_FORMAT,
): string {
  const at = new Date(iso);

  // `Intl.format` throws a `RangeError` on an invalid date, and this runs inside a `.map` over
  // server data. One malformed field taking the whole page to `error.tsx` is out of all
  // proportion; the raw value is legible and keeps the damage in the row that is wrong.
  if (Number.isNaN(at.getTime())) {
    return iso;
  }

  return format.format(at);
}
