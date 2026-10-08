import type { MeetingDigest, MeetingDigestContent } from '@repo/shared';
import { describe, expect, it } from 'vitest';

import { digestAnnouncement } from './meeting-digest-announcements';

const content = (generatedAt: string): MeetingDigestContent => ({
  summary: 'The team agreed the launch plan.',
  actionItems: [],
  decisions: [],
  generatedAt,
  outOfDate: false,
});

const FIRST = content('2026-10-08T09:00:00.000Z');
const SECOND = content('2026-10-08T09:05:00.000Z');

const digest = (overrides: Partial<MeetingDigest> = {}): MeetingDigest => ({
  meetingId: 'm1',
  version: 1,
  ...overrides,
});

describe('digestAnnouncement', () => {
  it.each<[string, MeetingDigest | null, MeetingDigest | null, string | null]>([
    // The page's opening state is not news, whatever it is.
    ['the first digest to arrive', null, digest({ status: 'ready', content: FIRST }), null],
    ['nothing changing', digest({ status: 'queued' }), digest({ status: 'queued' }), null],
    // The steps on the way are three interruptions where the end says everything.
    ['a digest being queued', digest(), digest({ status: 'queued' }), null],
    [
      'a queued digest being picked up',
      digest({ status: 'queued' }),
      digest({ status: 'generating' }),
      null,
    ],
    [
      'a digest arriving',
      digest({ status: 'generating' }),
      digest({ status: 'ready', content: FIRST }),
      'The meeting digest is ready.',
    ],
    [
      'a digest being replaced',
      digest({ status: 'generating', content: { ...FIRST, outOfDate: true } }),
      digest({ status: 'ready', content: SECOND }),
      'The meeting digest was updated.',
    ],
    [
      'a generation failing',
      digest({ status: 'generating' }),
      digest({ status: 'failed', failureReason: 'The digest could not be generated.' }),
      'Generating the meeting digest failed.',
    ],
    [
      'a replacement failing under a digest that stays',
      digest({ status: 'generating', content: { ...FIRST, outOfDate: true } }),
      digest({ status: 'failed', content: { ...FIRST, outOfDate: true } }),
      'Generating the meeting digest failed.',
    ],
    // Already failed, and still failed: a refetch of the same digest says nothing twice.
    [
      'a failure that was already shown',
      digest({ status: 'failed' }),
      digest({ status: 'failed' }),
      null,
    ],
    [
      'a digest withdrawn with its recording',
      digest({ status: 'ready', content: FIRST }),
      digest({ status: 'queued' }),
      'The meeting digest was removed.',
    ],
    [
      'the same digest marked out of date',
      digest({ status: 'ready', content: FIRST }),
      digest({ status: 'queued', content: { ...FIRST, outOfDate: true } }),
      null,
    ],
  ])('says the right thing for %s', (_case, previous, current, phrase) => {
    expect(digestAnnouncement(previous, current)).toBe(phrase);
  });
});
