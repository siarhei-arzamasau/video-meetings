import { describe, expect, it } from 'vitest';

import { formatMeetingTime, formatRelativeTime } from './date-time';

/**
 * Formatters are injected rather than stubbed: the production default deliberately follows the
 * reader's locale and zone, which is exactly what a test cannot assert against. Pinning both
 * here is how the assertion becomes an exact string instead of a regex.
 */
const inUtc = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});

const inAuckland = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Pacific/Auckland',
});

describe('formatMeetingTime', () => {
  it('renders an instant as a date and a time', () => {
    expect(formatMeetingTime('2026-08-05T14:30:00.000Z', inUtc)).toBe('5 Aug 2026, 14:30');
  });

  it('resolves the instant into the formatter zone rather than stripping the offset', () => {
    // The same moment, a day later and 12 hours on in Auckland. A formatter that ignored the
    // zone would answer with the UTC wall time.
    expect(formatMeetingTime('2026-08-05T14:30:00.000Z', inAuckland)).toBe('6 Aug 2026, 02:30');
  });

  it('reads a non-UTC offset as the instant it names', () => {
    expect(formatMeetingTime('2026-08-05T16:30:00.000+02:00', inUtc)).toBe('5 Aug 2026, 14:30');
  });

  it('accepts an instant written without seconds', () => {
    expect(formatMeetingTime('2026-08-05T14:30Z', inUtc)).toBe('5 Aug 2026, 14:30');
  });

  it('shows a malformed value verbatim instead of throwing', () => {
    // `Intl.format` raises a RangeError on an invalid date, and this runs inside a `.map` over
    // server data — one bad field must not take the whole page down.
    expect(formatMeetingTime('not-a-date', inUtc)).toBe('not-a-date');
  });

  it('formats with the reader own locale and zone when no formatter is given', () => {
    // Nothing to assert about the output — that is the point of the default. What matters is
    // that the default path exists and does not throw.
    expect(formatMeetingTime('2026-08-05T14:30:00.000Z')).not.toBe('');
  });
});

describe('formatRelativeTime', () => {
  const english = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const now = Date.parse('2026-09-20T12:00:00.000Z');
  const at = (iso: string) => formatRelativeTime(iso, now, english);

  it('says "now" for anything under a minute', () => {
    expect(at('2026-09-20T11:59:30.000Z')).toBe('now');
  });

  it('picks the largest unit that fits', () => {
    expect(at('2026-09-20T11:55:00.000Z')).toBe('5 minutes ago');
    expect(at('2026-09-20T09:00:00.000Z')).toBe('3 hours ago');
    expect(at('2026-09-19T12:00:00.000Z')).toBe('yesterday');
    expect(at('2026-09-06T12:00:00.000Z')).toBe('2 weeks ago');
    expect(at('2026-07-20T12:00:00.000Z')).toBe('2 months ago');
    expect(at('2024-09-20T12:00:00.000Z')).toBe('2 years ago');
  });

  it('handles an instant in the future the same way', () => {
    expect(at('2026-09-20T14:00:00.000Z')).toBe('in 2 hours');
  });

  it('returns the raw value for an unparseable instant rather than throwing', () => {
    expect(at('not a date')).toBe('not a date');
  });
});
