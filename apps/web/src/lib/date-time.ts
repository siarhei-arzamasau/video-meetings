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

const RELATIVE_TIME_FORMAT = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/** Unit boundaries, largest first. Anything under a minute is "just now" territory. */
const RELATIVE_UNITS: ReadonlyArray<[unit: Intl.RelativeTimeFormatUnit, ms: number]> = [
  ['year', 365 * 24 * 60 * 60 * 1_000],
  ['month', 30 * 24 * 60 * 60 * 1_000],
  ['week', 7 * 24 * 60 * 60 * 1_000],
  ['day', 24 * 60 * 60 * 1_000],
  ['hour', 60 * 60 * 1_000],
  ['minute', 60 * 1_000],
];

/**
 * An instant as "5 minutes ago" or "yesterday", in the reader's locale.
 *
 * `now` and the formatter are injectable for tests only, for the same reason `formatMeetingTime`
 * takes a formatter: determinism is the test's problem, not a reason to pin a locale. An
 * invalid instant renders as the raw value rather than throwing inside a row.
 */
export function formatRelativeTime(
  iso: string,
  now: number = Date.now(),
  format: Intl.RelativeTimeFormat = RELATIVE_TIME_FORMAT,
): string {
  const at = Date.parse(iso);

  if (Number.isNaN(at)) {
    return iso;
  }

  const elapsed = at - now;
  const magnitude = Math.abs(elapsed);

  for (const [unit, ms] of RELATIVE_UNITS) {
    if (magnitude >= ms) {
      return format.format(Math.round(elapsed / ms), unit);
    }
  }

  // `numeric: 'auto'` renders zero as the locale's word for the present ("now" in English).
  return format.format(0, 'second');
}
