import type { MeetingDigestOwner } from '@repo/shared';

import {
  DIGEST_MEETING_ID,
  FIRST_RECORDING_ID,
  buildMeetingDigestRecord,
} from './meeting-digest-record.fixture';
import { toMeetingDigest } from './meeting-digest.mapper';
import type { MeetingDigestActionItemRecord } from './meeting-digest.mapper';

const GRACE_ID = '22222222-2222-4222-8222-222222222222';
const ADA_ID = '11111111-1111-4111-8111-111111111111';

const item = (
  position: number,
  ownerName: string | null,
  ownerId: string | null,
): MeetingDigestActionItemRecord => ({
  id: `item-${String(position)}`,
  position,
  description: 'Send the release notes.',
  ownerName,
  ownerId,
});

/** The owner of each action item, as the digest of `items` is served with `ownerNames`. */
function ownersOf(
  items: MeetingDigestActionItemRecord[],
  ownerNames: ReadonlyMap<string, string>,
): Array<MeetingDigestOwner | undefined> {
  const record = buildMeetingDigestRecord({ actionItems: items });
  const digest = toMeetingDigest(
    DIGEST_MEETING_ID,
    record,
    [FIRST_RECORDING_ID],
    ownerNames,
    false,
  );

  return digest.content?.actionItems.map(({ owner }) => owner) ?? [];
}

describe('toMeetingDigest: the owner of an action item', () => {
  it('is a participant, a name as spoken, or absent — the three the PRD names', () => {
    const owners = ownersOf(
      [item(0, 'Grace', GRACE_ID), item(1, 'Linus', null), item(2, null, null)],
      new Map([[GRACE_ID, 'Grace Hopper']]),
    );

    expect(owners).toEqual([
      { kind: 'participant', userId: GRACE_ID, displayName: 'Grace Hopper' },
      { kind: 'name', name: 'Linus' },
      undefined,
    ]);
  });

  it('shows a linked member under the name they go by now, not the one that was spoken', () => {
    const owners = ownersOf([item(0, 'Grace', GRACE_ID)], new Map([[GRACE_ID, 'Amazing Grace']]));

    expect(owners).toEqual([
      { kind: 'participant', userId: GRACE_ID, displayName: 'Amazing Grace' },
    ]);
  });

  it('serves a participant as an id and a display name, and nothing else about them', () => {
    const [owner] = ownersOf([item(0, 'Grace', GRACE_ID)], new Map([[GRACE_ID, 'Grace Hopper']]));

    // The spoken name included: beside a link it would be a second, older name for a member.
    expect(Object.keys(owner ?? {}).toSorted()).toEqual(['displayName', 'kind', 'userId']);
  });

  it('falls back to the spoken name when a linked member has no name to show', () => {
    // The account went between the read of the digest and the read of its owners' names.
    expect(ownersOf([item(0, 'Grace', GRACE_ID)], new Map())).toEqual([
      { kind: 'name', name: 'Grace' },
    ]);
  });

  it('links nobody because a name was handed over: only a stored link makes a participant', () => {
    const owners = ownersOf(
      [item(0, 'Grace', null), item(1, null, null)],
      new Map([
        [GRACE_ID, 'Grace Hopper'],
        [ADA_ID, 'Ada Lovelace'],
      ]),
    );

    expect(owners).toEqual([{ kind: 'name', name: 'Grace' }, undefined]);
  });

  it('gives two items of one member the same participant', () => {
    const owners = ownersOf(
      [item(0, 'Grace', GRACE_ID), item(1, 'grace hopper', GRACE_ID)],
      new Map([[GRACE_ID, 'Grace Hopper']]),
    );

    expect(owners[0]).toEqual(owners[1]);
    expect(owners[0]).toMatchObject({ kind: 'participant', userId: GRACE_ID });
  });
});
