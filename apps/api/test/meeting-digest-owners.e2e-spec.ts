import type { MeetingDigest, MeetingDigestOwner } from '@repo/shared';

import { useApiSuite } from './utils/api-suite';
import type { ApiSuite } from './utils/api-suite';
import { useDigestSuite } from './utils/digest-suite';
import { FakeClaudeAgent } from './utils/fake-claude-agent';
import { EMAIL, OTHER_EMAIL, THIRD_EMAIL, USERS_ME_URL } from './utils/fixtures';
import { findMeetingDigestContentRows, findMeetingDigestRow } from './utils/meeting-digests-table';
import { createMeeting, registerUser } from './utils/meeting-files-suite';
import type { RegisteredUser } from './utils/meeting-files-suite';
import { useTranscriptionSuite } from './utils/transcription-suite';

const OUTSIDER_EMAIL = 'linus@example.com';

/** What was said. It names nobody: any name in the prompt was put there by the API. */
const TRANSCRIPT = 'The release notes go out on Friday and the review room has to be booked.';

/** A registered account under a name of its own choosing rather than its address's. */
async function registerAs(
  suite: ApiSuite,
  email: string,
  displayName: string,
): Promise<RegisteredUser> {
  const user = await registerUser(suite, email);

  await rename(suite, user, displayName);

  return user;
}

async function rename(suite: ApiSuite, user: RegisteredUser, displayName: string): Promise<void> {
  await suite
    .patch(USERS_ME_URL, { displayName })
    .set('Authorization', `Bearer ${user.token}`)
    .expect(200);
}

/** An answer with one action item per owner, in order; `null` is an item that names nobody. */
const answerNaming = (...owners: Array<string | null>): unknown => ({
  summary: 'The team planned the release.',
  actionItems: owners.map((owner, index) => ({ description: `Item ${String(index + 1)}.`, owner })),
  decisions: [],
});

const ownersOf = (digest: MeetingDigest): Array<MeetingDigestOwner | undefined> =>
  digest.content?.actionItems.map(({ owner }) => owner) ?? [];

/**
 * An action item's owner: a participant when the name the answer gave identifies exactly one
 * member of the meeting, the name as spoken otherwise, and absent when nobody was named.
 * Claude answers a name and nothing else; which member it is, is decided here.
 */
describe('the owner of an action item in a meeting digest', () => {
  const claude = new FakeClaudeAgent();
  const suite = useApiSuite({ overrides: [claude.override()] });
  const transcription = useTranscriptionSuite(suite);
  const digests = useDigestSuite(suite, transcription, claude);

  it('is a participant, a name as spoken, or nobody — by how many members the name identifies', async () => {
    const ada = await registerAs(suite, EMAIL, 'Ada Lovelace');
    const hopper = await registerAs(suite, OTHER_EMAIL, 'Grace Hopper');
    const kelly = await registerAs(suite, THIRD_EMAIL, 'Grace Kelly');
    const meeting = await createMeeting(suite, ada, [hopper.id, kelly.id]);
    const stream = await digests.watch(hopper.token, meeting.id);
    claude.reply = () => ({
      kind: 'answer',
      output: answerNaming('Ada', 'grace HOPPER', 'Grace', 'Linus', null),
    });

    await digests.transcribe(ada.token, meeting.id, TRANSCRIPT);
    await digests.worker().drain();

    const digest = await digests.read(ada.token, meeting.id);
    expect(ownersOf(digest)).toEqual([
      // A first name only the host has.
      { kind: 'participant', userId: ada.id, displayName: 'Ada Lovelace' },
      // A full name, whatever its case.
      { kind: 'participant', userId: hopper.id, displayName: 'Grace Hopper' },
      // A first name two members share: neither.
      { kind: 'name', name: 'Grace' },
      // A name nobody in the meeting has.
      { kind: 'name', name: 'Linus' },
      // Nobody was named: unassigned, which is the owner being absent.
      undefined,
    ]);
    expect(digest.content?.actionItems[4]).toEqual({
      id: expect.any(String),
      description: 'Item 5.',
    });

    // The spoken name is kept beside the link, never replaced by it.
    const { actionItems } = await findMeetingDigestContentRows(suite.prisma(), meeting.id);
    expect(actionItems.map((row) => [row.owner_name, row.owner_id])).toEqual([
      ['Ada', ada.id],
      ['grace HOPPER', hopper.id],
      ['Grace', null],
      ['Linus', null],
      [null, null],
    ]);

    // Every member is answered the same, and so is every open page: queued, generating, ready.
    await expect(digests.read(kelly.token, meeting.id)).resolves.toEqual(digest);
    await stream.next();
    await stream.next();
    await expect(stream.next()).resolves.toEqual(digest);
  });

  it('shows a renamed participant under the new name, with no generation', async () => {
    const ada = await registerAs(suite, EMAIL, 'Ada Lovelace');
    const guest = await registerUser(suite, OTHER_EMAIL);
    const meeting = await createMeeting(suite, ada, [guest.id]);
    claude.reply = () => ({ kind: 'answer', output: answerNaming('Ada Lovelace') });
    await digests.transcribe(ada.token, meeting.id, TRANSCRIPT);
    await digests.worker().drain();
    const before = await findMeetingDigestRow(suite.prisma(), meeting.id);

    // A name the spoken one no longer matches: the link is the member, not the spelling.
    await rename(suite, ada, 'Augusta King');

    expect(ownersOf(await digests.read(guest.token, meeting.id))).toEqual([
      { kind: 'participant', userId: ada.id, displayName: 'Augusta King' },
    ]);
    await expect(digests.worker().drain()).resolves.toBe(0);
    expect(claude.calls).toHaveLength(1);
    // Nothing of the digest was written for it: the name is read where it is kept.
    await expect(findMeetingDigestRow(suite.prisma(), meeting.id)).resolves.toEqual(before);
    await expect(findMeetingDigestContentRows(suite.prisma(), meeting.id)).resolves.toMatchObject({
      actionItems: [{ owner_name: 'Ada Lovelace', owner_id: ada.id }],
    });
  });

  it('stores an answer naming a user who is not in the meeting as a name, linked to nobody', async () => {
    const host = await registerAs(suite, EMAIL, 'Ada Lovelace');
    const guest = await registerAs(suite, OTHER_EMAIL, 'Grace Hopper');
    const outsider = await registerAs(suite, OUTSIDER_EMAIL, 'Linus Torvalds');
    const meeting = await createMeeting(suite, host, [guest.id]);
    // Forced: the full name of a real account, its first name, and its id itself.
    claude.reply = () => ({
      kind: 'answer',
      output: answerNaming('Linus Torvalds', 'Linus', outsider.id),
    });

    await digests.transcribe(host.token, meeting.id, TRANSCRIPT);
    await digests.worker().drain();

    const digest = await digests.read(guest.token, meeting.id);
    expect(digest.status).toBe('ready');
    expect(ownersOf(digest)).toEqual([
      { kind: 'name', name: 'Linus Torvalds' },
      { kind: 'name', name: 'Linus' },
      { kind: 'name', name: outsider.id },
    ]);
    const { actionItems } = await findMeetingDigestContentRows(suite.prisma(), meeting.id);
    expect(actionItems.map((row) => row.owner_id)).toEqual([null, null, null]);
  });

  it('links an owner without any member’s name, address, or id having left for Claude', async () => {
    const host = await registerAs(suite, EMAIL, 'Ada Lovelace');
    const guest = await registerAs(suite, OTHER_EMAIL, 'Grace Hopper');
    const meeting = await createMeeting(suite, host, [guest.id]);
    claude.reply = () => ({ kind: 'answer', output: answerNaming('Grace') });

    await digests.transcribe(host.token, meeting.id, TRANSCRIPT);
    await digests.worker().drain();

    // The link was made, so the members were read — after the answer, and on this side.
    expect(ownersOf(await digests.read(host.token, meeting.id))).toEqual([
      { kind: 'participant', userId: guest.id, displayName: 'Grace Hopper' },
    ]);
    expect(claude.calls).toHaveLength(1);
    const [sent] = claude.calls;
    expect(sent?.prompt).toBe(`<recording number="1">\n${TRANSCRIPT}\n</recording>`);
    const leaving = JSON.stringify([sent?.prompt, sent?.systemPrompt, sent?.schema]);
    const members = ['Ada Lovelace', 'Lovelace', 'Grace Hopper', 'Hopper', 'Grace'];
    for (const secret of [...members, EMAIL, OTHER_EMAIL, host.id, guest.id]) {
      expect(leaving).not.toContain(secret);
    }
  });
});
