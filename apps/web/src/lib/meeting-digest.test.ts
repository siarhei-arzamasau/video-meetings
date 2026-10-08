import type { MeetingDigest, MeetingDigestContent } from '@repo/shared';
import { describe, expect, it } from 'vitest';

import {
  DIGEST_AI_NOTE,
  NO_ACTION_ITEMS_LABEL,
  NO_DECISIONS_LABEL,
  UNASSIGNED_LABEL,
  digestPresentation,
  isDigestUnderWay,
  laterDigest,
  transcribedRecordingIds,
} from './meeting-digest';

const CONTENT: MeetingDigestContent = {
  summary: 'The team agreed the launch plan.',
  actionItems: [
    {
      id: 'a1',
      description: 'Send the deck.',
      owner: { kind: 'participant', userId: 'u2', displayName: 'Ada Lovelace' },
    },
    { id: 'a2', description: 'Call the venue.', owner: { kind: 'name', name: 'Grace' } },
    { id: 'a3', description: 'Book the room.' },
  ],
  decisions: [{ id: 'd1', description: 'Ship on Friday.' }],
  generatedAt: '2026-10-08T09:00:00.000Z',
  outOfDate: false,
};

const digest = (overrides: Partial<MeetingDigest> = {}): MeetingDigest => ({
  meetingId: 'm1',
  version: 4,
  ...overrides,
});

describe('laterDigest', () => {
  const held = digest({ version: 4, status: 'generating' });

  it.each<[string, MeetingDigest | null, MeetingDigest, 'fetch' | 'event', 'incoming' | 'held']>([
    ['takes the first digest it is given', null, digest({ version: 0 }), 'fetch', 'incoming'],
    ['takes an event of a higher version', held, digest({ version: 5 }), 'event', 'incoming'],
    ['takes a fetch of a higher version', held, digest({ version: 5 }), 'fetch', 'incoming'],
    // A slow fetch must not put a digest back to the status an event has already moved on.
    ['keeps what it holds over an older fetch', held, digest({ version: 3 }), 'fetch', 'held'],
    ['keeps what it holds over an older event', held, digest({ version: 3 }), 'event', 'held'],
    // A linked owner's new name, and an action that left with the last recording, change
    // what the API answers under an unchanged version: only a fetch can bring either.
    ['takes a fetch of the same version', held, digest({ version: 4 }), 'fetch', 'incoming'],
    // An event of a version already held is that digest announced twice.
    ['keeps what it holds over an event of the same version', held, digest(), 'event', 'held'],
    [
      "takes another meeting's digest whatever its version",
      held,
      digest({ meetingId: 'm2', version: 1 }),
      'event',
      'incoming',
    ],
  ])('%s', (_case, current, incoming, from, expected) => {
    expect(laterDigest(current, incoming, from)).toBe(expected === 'held' ? current : incoming);
  });
});

describe('isDigestUnderWay', () => {
  it.each<[MeetingDigest | null, boolean]>([
    [null, false],
    [digest(), false],
    [digest({ status: 'queued' }), true],
    [digest({ status: 'generating' }), true],
    [digest({ status: 'ready', content: CONTENT }), false],
    [digest({ status: 'failed' }), false],
  ])('%j → %s', (current, expected) => {
    expect(isDigestUnderWay(current)).toBe(expected);
  });
});

describe('transcribedRecordingIds', () => {
  it('names the transcribed recordings, in an order that does not depend on the list', () => {
    const files = [
      { id: 'f3', transcriptionStatus: 'transcribed' },
      { id: 'f2', transcriptionStatus: 'transcribing' },
      { id: 'f1', transcriptionStatus: 'transcribed' },
      { id: 'f4', transcriptionStatus: 'failed' },
      { id: 'f5' },
    ] as const;

    expect(transcribedRecordingIds(files)).toEqual(['f1', 'f3']);
    expect(transcribedRecordingIds(files.toReversed())).toEqual(['f1', 'f3']);
  });
});

describe('digestPresentation', () => {
  it.each<[string, MeetingDigest | null]>([
    ['a digest that has not been fetched', null],
    ['a meeting that never had one', digest({ version: 0 })],
    ['a digest with neither a status nor content', digest()],
    // Withheld: one of its recordings was deleted and nothing has replaced it yet.
    ['a ready digest whose content is withheld', digest({ status: 'ready' })],
    // What may be asked for is not something a digest shows: `digestSectionView` adds the
    // control, for the reader it is offered to.
    ['only an action somebody could ask for', digest({ availableAction: 'generate' })],
  ])('shows nothing at all for %s', (_case, current) => {
    expect(digestPresentation(current)).toBeNull();
  });

  it.each<[MeetingDigest, unknown]>([
    [digest({ status: 'queued' }), { kind: 'queued', label: 'Digest queued' }],
    [digest({ status: 'generating' }), { kind: 'generating', label: 'Generating digest…' }],
    [
      digest({ status: 'failed', failureReason: 'The recordings are too long.' }),
      { kind: 'failed', label: 'Digest failed', reason: 'The recordings are too long.' },
    ],
    [
      digest({ status: 'failed' }),
      { kind: 'failed', label: 'Digest failed', reason: 'The digest could not be generated.' },
    ],
  ])('says where a generation stands: %j', (current, status) => {
    expect(digestPresentation(current)).toEqual({ status, content: null });
  });

  it('shows the three parts of a ready digest, and no status beside them', () => {
    expect(digestPresentation(digest({ status: 'ready', content: CONTENT }))).toEqual({
      status: null,
      content: {
        summary: 'The team agreed the launch plan.',
        actionItems: [
          {
            id: 'a1',
            description: 'Send the deck.',
            owner: 'Ada Lovelace',
            ownerKind: 'participant',
          },
          { id: 'a2', description: 'Call the venue.', owner: 'Grace', ownerKind: 'name' },
          {
            id: 'a3',
            description: 'Book the room.',
            owner: UNASSIGNED_LABEL,
            ownerKind: 'unassigned',
          },
        ],
        noActionItems: null,
        decisions: [{ id: 'd1', description: 'Ship on Friday.' }],
        noDecisions: null,
        generatedAt: '2026-10-08T09:00:00.000Z',
        outOfDate: false,
        note: DIGEST_AI_NOTE,
      },
    });
  });

  it('says so under each heading of a digest with no action items and no decisions', () => {
    const empty = { ...CONTENT, actionItems: [], decisions: [] };

    expect(digestPresentation(digest({ status: 'ready', content: empty }))?.content).toMatchObject({
      actionItems: [],
      noActionItems: NO_ACTION_ITEMS_LABEL,
      decisions: [],
      noDecisions: NO_DECISIONS_LABEL,
    });
    expect(NO_ACTION_ITEMS_LABEL).toBe('No action items were identified');
    expect(NO_DECISIONS_LABEL).toBe('No decisions were recorded');
    expect(UNASSIGNED_LABEL).toBe('Unassigned');
  });

  it.each<[string, MeetingDigest['status'], string | null]>([
    ['queued', 'queued', 'Digest queued'],
    ['being generated', 'generating', 'Generating digest…'],
    ['failed', 'failed', 'Digest failed'],
    // A recording transcribed with the setting off: nothing is replacing it.
    ['not asked for', undefined, null],
  ])(
    'keeps an out-of-date digest readable beside a replacement that is %s',
    (_case, status, label) => {
      const stale = { ...CONTENT, outOfDate: true };
      const shown = digestPresentation(
        digest({ ...(status === undefined ? {} : { status }), content: stale }),
      );

      expect(shown?.content).toMatchObject({ outOfDate: true, summary: CONTENT.summary });
      expect(shown?.status?.label ?? null).toBe(label);
    },
  );

  it('hands every string of a digest on as it came, markup included', () => {
    const markup = '<img src=x onerror="alert(1)"> & <b>bold</b>';
    const hostile: MeetingDigestContent = {
      ...CONTENT,
      summary: markup,
      actionItems: [{ id: 'a1', description: markup, owner: { kind: 'name', name: markup } }],
      decisions: [{ id: 'd1', description: markup }],
    };

    const shown = digestPresentation(digest({ status: 'ready', content: hostile }))?.content;

    // Text for React to escape: nothing here is ever a node, and nothing is stripped.
    expect(shown?.summary).toBe(markup);
    expect(shown?.actionItems[0]).toMatchObject({ description: markup, owner: markup });
    expect(shown?.decisions[0]?.description).toBe(markup);
  });
});
