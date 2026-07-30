import type { Meeting } from '@repo/shared';
import { describe, expect, it } from 'vitest';

import { LATEST_MEETINGS_COUNT, latestMeetings } from './meetings';

/** A meeting that differs from its neighbours only where the test says it does. */
function meeting(overrides: Partial<Meeting> & Pick<Meeting, 'id' | 'scheduledAt'>): Meeting {
  return {
    title: `Meeting ${overrides.id}`,
    status: 'scheduled',
    hostId: '11111111-1111-4111-8111-111111111111',
    participantIds: [],
    ...overrides,
  };
}

/**
 * More meetings than the list shows, so "takes the latest N" and "takes the first N it was
 * given" cannot both pass. Derived from the constant rather than hardcoded: raising the limit
 * must not silently turn these into tests of a full list.
 */
const ascending: ReadonlyArray<Meeting> = [
  meeting({ id: 'a', scheduledAt: '2026-05-02T15:00:00.000Z' }),
  meeting({ id: 'b', scheduledAt: '2026-07-28T09:30:00.000Z' }),
  meeting({ id: 'c', scheduledAt: '2026-08-05T14:30:00.000Z' }),
  meeting({ id: 'd', scheduledAt: '2026-10-20T11:15:00.000Z' }),
  meeting({ id: 'e', scheduledAt: '2026-12-01T08:00:00.000Z' }),
];

describe('latestMeetings', () => {
  it('takes the latest few, newest first, from the order the API sends', () => {
    expect(ascending).toHaveLength(LATEST_MEETINGS_COUNT + 2);

    expect(latestMeetings(ascending).map((entry) => entry.id)).toEqual(['e', 'd', 'c']);
  });

  it('sorts rather than reversing, so a differently ordered list gives the same answer', () => {
    const shuffled = [ascending[2], ascending[0], ascending[4], ascending[3], ascending[1]].filter(
      (entry): entry is Meeting => entry !== undefined,
    );

    expect(latestMeetings(shuffled).map((entry) => entry.id)).toEqual(['e', 'd', 'c']);
  });

  it('leaves the argument untouched, because it is the array held in component state', () => {
    const input = [...ascending];
    const before = input.map((entry) => entry.id);

    const result = latestMeetings(input);

    expect(input.map((entry) => entry.id)).toEqual(before);
    expect(result).not.toBe(input);
  });

  it('returns everything it was given when there is less than a full list', () => {
    const two = ascending.slice(0, 2);

    expect(latestMeetings(two).map((entry) => entry.id)).toEqual(['b', 'a']);
  });

  it('returns nothing for a new account', () => {
    expect(latestMeetings([])).toEqual([]);
  });

  it('breaks a tie on id ascending, whichever order the tied pair arrives in', () => {
    const sameInstant = '2026-08-05T14:30:00.000Z';
    const first = meeting({ id: 'aaa', scheduledAt: sameInstant });
    const second = meeting({ id: 'bbb', scheduledAt: sameInstant });

    // One relative order regardless of input order: the same direction the API's
    // `orderBy: [{ scheduledAt }, { id }]` uses, so the app never shows two orderings.
    expect(latestMeetings([first, second]).map((entry) => entry.id)).toEqual(['aaa', 'bbb']);
    expect(latestMeetings([second, first]).map((entry) => entry.id)).toEqual(['aaa', 'bbb']);
  });

  it('treats an abbreviated instant as the moment it names, not as a shorter string', () => {
    // `…T09:00Z` sorts before `…T09:00:00.000Z` lexicographically while naming the same instant,
    // which is why the comparison parses rather than compares text.
    const abbreviated = meeting({ id: 'abbrev', scheduledAt: '2026-09-01T09:00Z' });
    const earlier = meeting({ id: 'earlier', scheduledAt: '2026-08-31T09:00:00.000Z' });

    expect(latestMeetings([earlier, abbreviated], 1).map((entry) => entry.id)).toEqual(['abbrev']);
  });

  it('honours an explicit limit, so the count is not baked into the helper', () => {
    expect(latestMeetings(ascending, 1).map((entry) => entry.id)).toEqual(['e']);
  });
});
