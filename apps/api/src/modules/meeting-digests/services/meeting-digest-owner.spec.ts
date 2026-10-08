import type { UserDisplayName } from '../../user/queries/find-users-by-ids.query';
import type { MeetingDigestAnswer } from './meeting-digest-answer';
import { linkOwners, matchOwner } from './meeting-digest-owner';

const GRACE_ID = '11111111-1111-4111-8111-111111111111';
const ALAN_ID = '22222222-2222-4222-8222-222222222222';
const ADA_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_GRACE_ID = '44444444-4444-4444-8444-444444444444';

const GRACE: UserDisplayName = { id: GRACE_ID, displayName: 'Grace Hopper' };
const ALAN: UserDisplayName = { id: ALAN_ID, displayName: 'Alan Turing' };
/** A name nobody chose: what registration derives from `ada.lovelace@example.com`. */
const ADA: UserDisplayName = { id: ADA_ID, displayName: 'ada.lovelace' };
const OTHER_GRACE: UserDisplayName = { id: OTHER_GRACE_ID, displayName: 'Grace Kelly' };

const MEMBERS = [GRACE, ALAN, ADA];

describe('matchOwner', () => {
  it.each([
    ['a full name', 'Grace Hopper', GRACE_ID],
    ['a first name only one member has', 'Grace', GRACE_ID],
    ['a last name only one member has', 'Turing', ALAN_ID],
    ['a name in another case', 'gRACE hopper', GRACE_ID],
    ['a full name with its words the other way round', 'Hopper, Grace', GRACE_ID],
    ['a name with space and punctuation around it', '  Grace.  ', GRACE_ID],
    ['a first name against a name derived from an email address', 'Ada', ADA_ID],
    ['a full name against a name derived from an email address', 'Ada Lovelace', ADA_ID],
  ])('links %s to the one member it identifies', (_case, spokenName, memberId) => {
    expect(matchOwner(spokenName, MEMBERS)).toBe(memberId);
  });

  it.each([
    ['a name nobody in the meeting has', 'Linus'],
    ['a first name with a last name nobody has', 'Grace Kelly'],
    ['a name with a word no member has, a title included', 'Dr Hopper'],
    ['the start of a name rather than a word of it', 'Gra'],
    ['a longer name a member has the start of', 'Alana'],
    ['an initial', 'G. Hopper'],
    ['a name written in another script', 'Грейс'],
    ['a name without the accent a member has', 'Zoe'],
    ['an empty name', ''],
    ['a name of spaces', '   '],
    ['a name with no word in it', '— ?'],
  ])('links %s to nobody', (_case, spokenName) => {
    const members = [...MEMBERS, { id: 'zoe', displayName: 'Zoë Quinn' }];

    expect(matchOwner(spokenName, members)).toBeNull();
  });

  it('links a first name two members share to neither', () => {
    expect(matchOwner('Grace', [...MEMBERS, OTHER_GRACE])).toBeNull();
  });

  it('still links the full name of one of two members who share a first name', () => {
    expect(matchOwner('Grace Kelly', [...MEMBERS, OTHER_GRACE])).toBe(OTHER_GRACE_ID);
  });

  it('links a name two members both have in full to neither', () => {
    const namesake = { id: OTHER_GRACE_ID, displayName: 'Grace Hopper' };

    expect(matchOwner('Grace Hopper', [...MEMBERS, namesake])).toBeNull();
  });

  it('counts a member once, however often the list names them', () => {
    expect(matchOwner('Grace', [GRACE, ALAN, GRACE])).toBe(GRACE_ID);
  });

  it('treats one name typed with a composed and a decomposed accent as the same name', () => {
    const composed = { id: 'zoe', displayName: 'Zoë Quinn' };

    expect(matchOwner('Zoë', [composed])).toBe('zoe');
  });

  it('links nobody in a meeting whose members are not known', () => {
    expect(matchOwner('Grace', [])).toBeNull();
  });
});

/** An answer with one action item per name; `undefined` is an item that names nobody. */
const answerNaming = (...ownerNames: Array<string | undefined>): MeetingDigestAnswer => ({
  summary: 'The team agreed to ship on Friday.',
  actionItems: ownerNames.map((ownerName) =>
    ownerName === undefined
      ? { description: 'Book the room.' }
      : { description: 'Send.', ownerName },
  ),
  decisions: [],
});

describe('linkOwners', () => {
  it('maps each spoken name that identifies one member to that member, and no other name', () => {
    const links = linkOwners(answerNaming('Grace', 'Linus', undefined, 'Alan Turing'), MEMBERS);

    expect([...links]).toEqual([
      ['Grace', GRACE_ID],
      ['Alan Turing', ALAN_ID],
    ]);
  });

  it('keeps two spellings of one member as two names of the same member', () => {
    const links = linkOwners(answerNaming('Grace', 'grace hopper', 'Grace'), MEMBERS);

    expect([...links]).toEqual([
      ['Grace', GRACE_ID],
      ['grace hopper', GRACE_ID],
    ]);
  });

  it('links nothing for an answer that names nobody', () => {
    expect(linkOwners(answerNaming(undefined, undefined), MEMBERS).size).toBe(0);
  });
});
