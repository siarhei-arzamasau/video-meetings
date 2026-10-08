import {
  MAX_DIGEST_ITEM_LENGTH,
  MAX_DIGEST_ITEMS,
  MAX_DIGEST_OWNER_LENGTH,
  MAX_DIGEST_SUMMARY_LENGTH,
} from '../meeting-digest.constants';
import { MEETING_DIGEST_ANSWER_SCHEMA, readMeetingDigestAnswer } from './meeting-digest-answer';

const SUMMARY = 'The team reviewed the beta feedback and moved the launch.';
const ITEM = { description: 'Rewrite the onboarding emails by Friday.', owner: 'Alice Johnson' };
const DECISION = { description: 'The public launch moves to 15 April.' };

/** A whole answer with `overrides` laid over it, so a case names only what it is about. */
function answerWith(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { summary: SUMMARY, actionItems: [ITEM], decisions: [DECISION], ...overrides };
}

describe('readMeetingDigestAnswer', () => {
  it('reads a digest, an owner being a name as it was spoken', () => {
    expect(readMeetingDigestAnswer(answerWith())).toEqual({
      answer: {
        summary: SUMMARY,
        actionItems: [{ description: ITEM.description, ownerName: 'Alice Johnson' }],
        decisions: [DECISION],
      },
    });
  });

  it.each([
    ['null', null],
    // Not a different owner: a model that pads the field has still named nobody.
    ['blank', '   '],
  ])('reads an owner that is %s as nobody', (_case, owner) => {
    const reading = readMeetingDigestAnswer(answerWith({ actionItems: [{ ...ITEM, owner }] }));

    expect(reading).toEqual({
      answer: expect.objectContaining({ actionItems: [{ description: ITEM.description }] }),
    });
  });

  it('reads empty lists as the answer they are', () => {
    expect(readMeetingDigestAnswer(answerWith({ actionItems: [], decisions: [] }))).toEqual({
      answer: { summary: SUMMARY, actionItems: [], decisions: [] },
    });
  });

  it('trims what it reads', () => {
    const reading = readMeetingDigestAnswer({
      summary: `  ${SUMMARY}\n`,
      actionItems: [{ description: ` ${ITEM.description} `, owner: ' Alice Johnson ' }],
      decisions: [{ description: `\t${DECISION.description}` }],
    });

    expect(reading).toEqual(readMeetingDigestAnswer(answerWith()));
  });

  it('keeps markup as the characters it is, neither stripped nor escaped', () => {
    // The digest is rendered as text. A guard that "cleaned" it would be a second place
    // deciding what is safe, and the one that renders is the place that knows.
    const markup = '<script>alert("digest")</script> & <b>bold</b>';
    const reading = readMeetingDigestAnswer(
      answerWith({ summary: markup, decisions: [{ description: markup }] }),
    );

    expect(reading).toEqual({
      answer: expect.objectContaining({ summary: markup, decisions: [{ description: markup }] }),
    });
  });

  it('accepts every bound at the bound', () => {
    const reading = readMeetingDigestAnswer({
      summary: 's'.repeat(MAX_DIGEST_SUMMARY_LENGTH),
      actionItems: Array.from({ length: MAX_DIGEST_ITEMS }, () => ({
        description: 'd'.repeat(MAX_DIGEST_ITEM_LENGTH),
        owner: 'o'.repeat(MAX_DIGEST_OWNER_LENGTH),
      })),
      decisions: Array.from({ length: MAX_DIGEST_ITEMS }, () => ({
        description: 'd'.repeat(MAX_DIGEST_ITEM_LENGTH),
      })),
    });

    expect(reading).toHaveProperty('answer');
  });

  it.each<[string, unknown]>([
    ['nothing at all', undefined],
    ['null', null],
    ['prose', 'The team moved the launch.'],
    ['a list', [answerWith()]],
    ['an object with no summary', { actionItems: [], decisions: [] }],
    ['an object with no action items', { summary: SUMMARY, decisions: [] }],
    ['an object with no decisions', { summary: SUMMARY, actionItems: [] }],
    ['a field nobody asked for', answerWith({ ownerId: '11111111-1111-4111-8111-111111111111' })],
    ['a summary that is not text', answerWith({ summary: 42 })],
    ['an empty summary', answerWith({ summary: '' })],
    ['a summary of whitespace', answerWith({ summary: ' \n ' })],
    [
      'a summary past its bound',
      answerWith({ summary: 's'.repeat(MAX_DIGEST_SUMMARY_LENGTH + 1) }),
    ],
    ['action items that are not a list', answerWith({ actionItems: { 0: ITEM } })],
    [
      'more action items than the bound',
      answerWith({ actionItems: Array.from({ length: MAX_DIGEST_ITEMS + 1 }, () => ITEM) }),
    ],
    ['an action item that is a sentence', answerWith({ actionItems: [ITEM.description] })],
    ['an action item with no description', answerWith({ actionItems: [{ owner: null }] })],
    [
      'an action item with no owner field',
      answerWith({ actionItems: [{ description: 'Do it.' }] }),
    ],
    [
      'an action item that points at a user',
      answerWith({ actionItems: [{ ...ITEM, userId: '11111111-1111-4111-8111-111111111111' }] }),
    ],
    ['an empty description', answerWith({ actionItems: [{ ...ITEM, description: ' ' }] })],
    [
      'a description past its bound',
      answerWith({
        actionItems: [{ ...ITEM, description: 'd'.repeat(MAX_DIGEST_ITEM_LENGTH + 1) }],
      }),
    ],
    ['an owner that is not a name', answerWith({ actionItems: [{ ...ITEM, owner: 7 }] })],
    ['an owner that is an object', answerWith({ actionItems: [{ ...ITEM, owner: { id: 'x' } }] })],
    [
      'an owner past its bound',
      answerWith({ actionItems: [{ ...ITEM, owner: 'o'.repeat(MAX_DIGEST_OWNER_LENGTH + 1) }] }),
    ],
    ['decisions that are not a list', answerWith({ decisions: DECISION.description })],
    [
      'more decisions than the bound',
      answerWith({ decisions: Array.from({ length: MAX_DIGEST_ITEMS + 1 }, () => DECISION) }),
    ],
    ['a decision that is a sentence', answerWith({ decisions: [DECISION.description] })],
    ['a decision with an owner', answerWith({ decisions: [{ ...DECISION, owner: 'Alice' }] })],
    [
      'a decision past its bound',
      answerWith({ decisions: [{ description: 'd'.repeat(MAX_DIGEST_ITEM_LENGTH + 1) }] }),
    ],
  ])('refuses %s', (_case, value) => {
    const reading = readMeetingDigestAnswer(value);

    expect(reading).toEqual({ problem: expect.any(String) });
  });

  it('says where an answer went wrong without quoting it', () => {
    const marker = 'A-SENTENCE-ONLY-THE-MODEL-WROTE';
    const reading = readMeetingDigestAnswer(
      answerWith({
        actionItems: [ITEM, { description: marker.repeat(MAX_DIGEST_ITEM_LENGTH), owner: null }],
      }),
    );

    // The problem is for the log, and a log is no place for what was said in a meeting.
    expect(reading).toEqual({ problem: expect.stringContaining('actionItems[1].description') });
    expect(JSON.stringify(reading)).not.toContain(marker);
  });
});

describe('MEETING_DIGEST_ANSWER_SCHEMA', () => {
  it('states the bounds the guard enforces, so the model is told what will be refused', () => {
    expect(MEETING_DIGEST_ANSWER_SCHEMA).toMatchObject({
      additionalProperties: false,
      required: ['summary', 'actionItems', 'decisions'],
      properties: {
        summary: { maxLength: MAX_DIGEST_SUMMARY_LENGTH },
        actionItems: {
          maxItems: MAX_DIGEST_ITEMS,
          items: {
            additionalProperties: false,
            required: ['description', 'owner'],
            properties: { description: { maxLength: MAX_DIGEST_ITEM_LENGTH } },
          },
        },
        decisions: {
          maxItems: MAX_DIGEST_ITEMS,
          items: { additionalProperties: false, required: ['description'] },
        },
      },
    });
  });
});
