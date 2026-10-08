import {
  MAX_DIGEST_ITEM_LENGTH,
  MAX_DIGEST_ITEMS,
  MAX_DIGEST_OWNER_LENGTH,
  MAX_DIGEST_SUMMARY_LENGTH,
} from '../meeting-digest.constants';

/**
 * A digest as Claude answers it: no ids, no status, and an owner that is only ever a name.
 * Linking that name to a participant is the API's decision, made from the meeting's members,
 * so no answer — however it was arrived at — can point at a user.
 */
export interface MeetingDigestAnswer {
  summary: string;
  /** `ownerName` absent: the transcripts named nobody for it. */
  actionItems: ReadonlyArray<{ description: string; ownerName?: string }>;
  decisions: ReadonlyArray<{ description: string }>;
}

export type MeetingDigestAnswerReading = { answer: MeetingDigestAnswer } | { problem: string };

const ANSWER_KEYS = ['summary', 'actionItems', 'decisions'] as const;
const ACTION_ITEM_KEYS = ['description', 'owner'] as const;
const DECISION_KEYS = ['description'] as const;

const DESCRIPTION_SCHEMA = { type: 'string', minLength: 1, maxLength: MAX_DIGEST_ITEM_LENGTH };

/**
 * The schema the answer is bound to. `owner` is required and nullable rather than optional,
 * so "nobody was named" is something the model says, not something it leaves out.
 */
export const MEETING_DIGEST_ANSWER_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [...ANSWER_KEYS],
  properties: {
    summary: { type: 'string', minLength: 1, maxLength: MAX_DIGEST_SUMMARY_LENGTH },
    actionItems: {
      type: 'array',
      maxItems: MAX_DIGEST_ITEMS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [...ACTION_ITEM_KEYS],
        properties: {
          description: DESCRIPTION_SCHEMA,
          owner: {
            anyOf: [{ type: 'string', maxLength: MAX_DIGEST_OWNER_LENGTH }, { type: 'null' }],
          },
        },
      },
    },
    decisions: {
      type: 'array',
      maxItems: MAX_DIGEST_ITEMS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [...DECISION_KEYS],
        properties: { description: DESCRIPTION_SCHEMA },
      },
    },
  },
};

/** Thrown and caught inside this file: where an answer stopped being a digest. */
class UnfitAnswer extends Error {}

/**
 * Reads what Claude answered as a digest, or says where it is not one. The schema above was
 * already enforced by the SDK; this is the API's own check of the same shape, with the same
 * bounds, because the SDK's is a claim made on another process's behalf.
 *
 * All or nothing: one unfit field refuses the whole answer, so a digest is never stored in
 * part. `problem` names a path and a rule and **never quotes the answer** — it is for a log.
 */
export function readMeetingDigestAnswer(value: unknown): MeetingDigestAnswerReading {
  try {
    const fields = recordOf(value, ANSWER_KEYS, 'the answer');

    return {
      answer: {
        summary: textOf(fields['summary'], MAX_DIGEST_SUMMARY_LENGTH, 'summary'),
        actionItems: listOf(fields['actionItems'], 'actionItems').map(actionItemOf),
        decisions: listOf(fields['decisions'], 'decisions').map(decisionOf),
      },
    };
  } catch (error) {
    if (error instanceof UnfitAnswer) {
      return { problem: error.message };
    }

    throw error;
  }
}

function actionItemOf(value: unknown, index: number): MeetingDigestAnswer['actionItems'][number] {
  const path = `actionItems[${index}]`;
  const fields = recordOf(value, ACTION_ITEM_KEYS, path);
  const description = textOf(fields['description'], MAX_DIGEST_ITEM_LENGTH, `${path}.description`);
  const ownerName = ownerNameOf(fields['owner'], `${path}.owner`);

  return ownerName === undefined ? { description } : { description, ownerName };
}

function decisionOf(value: unknown, index: number): MeetingDigestAnswer['decisions'][number] {
  const path = `decisions[${index}]`;
  const fields = recordOf(value, DECISION_KEYS, path);

  return {
    description: textOf(fields['description'], MAX_DIGEST_ITEM_LENGTH, `${path}.description`),
  };
}

/** A name, or `undefined` for nobody — which a `null` and a blank string both say. */
function ownerNameOf(value: unknown, path: string): string | undefined {
  if (value === null) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new UnfitAnswer(`${path} is neither a name nor null`);
  }

  const name = value.trim();

  if (name.length > MAX_DIGEST_OWNER_LENGTH) {
    throw new UnfitAnswer(`${path} is longer than ${MAX_DIGEST_OWNER_LENGTH} characters`);
  }

  return name === '' ? undefined : name;
}

/** An object with exactly `keys`: a field nobody asked for is as unfit as one left out. */
function recordOf(
  value: unknown,
  keys: ReadonlyArray<string>,
  path: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new UnfitAnswer(`${path} is not an object`);
  }

  const present = Object.keys(value);

  if (present.length !== keys.length || keys.some((key) => !present.includes(key))) {
    throw new UnfitAnswer(`${path} does not have exactly the fields ${keys.join(', ')}`);
  }

  return value as Record<string, unknown>;
}

function listOf(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new UnfitAnswer(`${path} is not a list`);
  }

  if (value.length > MAX_DIGEST_ITEMS) {
    throw new UnfitAnswer(`${path} has more than ${MAX_DIGEST_ITEMS} entries`);
  }

  return value;
}

/** Text with something in it, trimmed, and no longer than `maxLength`. */
function textOf(value: unknown, maxLength: number, path: string): string {
  if (typeof value !== 'string') {
    throw new UnfitAnswer(`${path} is not text`);
  }

  const text = value.trim();

  if (text === '') {
    throw new UnfitAnswer(`${path} is empty`);
  }

  if (text.length > maxLength) {
    throw new UnfitAnswer(`${path} is longer than ${maxLength} characters`);
  }

  return text;
}
