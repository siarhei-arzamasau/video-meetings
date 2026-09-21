import {
  DISPLAY_NAME_MESSAGE,
  MAX_DISPLAY_NAME_LENGTH,
  MIN_DISPLAY_NAME_LENGTH,
} from '@repo/shared';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { UpdateDisplayNameDto } from './update-display-name.dto';

/** The global pipe's two steps on one body: transform, then validate. */
function validate(body: unknown): { dto: UpdateDisplayNameDto; messages: string[] } {
  const dto = plainToInstance(UpdateDisplayNameDto, body);

  return {
    dto,
    messages: validateSync(dto).flatMap((error) => Object.values(error.constraints ?? {})),
  };
}

/**
 * The DTO is the HTTP layer's copy of the rule the handler owns, and this spec covers the two
 * things only it can answer: what value reaches the handler after the transform, and what the
 * browser is told when the value is refused. `whitelist` and `forbidNonWhitelisted` belong to
 * the global pipe rather than to this class, so the body that smuggles an `id` is an e2e case.
 */
describe('UpdateDisplayNameDto', () => {
  it('trims the name, so the handler is handed what will be stored', () => {
    const { dto, messages } = validate({ displayName: '   Ada Lovelace   ' });

    expect(messages).toEqual([]);
    expect(dto.displayName).toBe('Ada Lovelace');
  });

  it.each([
    ['the minimum', MIN_DISPLAY_NAME_LENGTH],
    ['the maximum', MAX_DISPLAY_NAME_LENGTH],
  ])('accepts a name of exactly %s characters, padded past it', (_case, length) => {
    const name = 'a'.repeat(length);

    const { dto, messages } = validate({ displayName: `    ${name}    ` });

    expect(messages).toEqual([]);
    expect(dto.displayName).toBe(name);
  });

  it('counts an emoji as one character, the rule the handler applies too', () => {
    // 160 UTF-16 code units. Were this layer and the handler to count differently, the name
    // would pass here and come back from the handler as a 400 calling it too long.
    const name = '\u{1F600}'.repeat(MAX_DISPLAY_NAME_LENGTH);

    expect(validate({ displayName: name }).messages).toEqual([]);
    expect(validate({ displayName: `${name}\u{1F600}` }).messages).toEqual([DISPLAY_NAME_MESSAGE]);
  });

  it('counts a variation selector as a code point of its own, as the handler does', () => {
    // validator.js, behind `@Length`, counts "\u2764\uFE0F" as one character; the shared rule
    // counts two. Following validator.js here would let 41 of them through to a handler that
    // counts 82 and refuses them.
    const heart = '\u2764\uFE0F';
    const pairs = MAX_DISPLAY_NAME_LENGTH / 2;

    expect(validate({ displayName: heart.repeat(pairs) }).messages).toEqual([]);
    expect(validate({ displayName: heart.repeat(pairs + 1) }).messages).toEqual([
      DISPLAY_NAME_MESSAGE,
    ]);
  });

  // One message for every way a name can be rejected, and it comes from `@repo/shared` — the
  // browser renders that same constant, so a field that turns red says what the server would.
  it.each([
    ['blank', ''],
    ['whitespace-only', '   '],
    ['over the maximum once trimmed', `  ${'a'.repeat(MAX_DISPLAY_NAME_LENGTH + 1)}  `],
  ])('rejects a %s name with the shared message, once', (_case, displayName) => {
    expect(validate({ displayName }).messages).toEqual([DISPLAY_NAME_MESSAGE]);
  });

  it.each([
    ['a number', 42],
    ['a missing field', undefined],
  ])('rejects %s without repeating the bounds', (_case, displayName) => {
    // A non-string fails `@IsString` and the bounds together. That is why the bounds are one
    // decorator rather than a minimum and a maximum carrying the same custom message:
    // paired, they would print the same sentence to the user twice.
    const { messages } = validate({ displayName });

    expect(messages.filter((message) => message === DISPLAY_NAME_MESSAGE)).toHaveLength(1);
    expect(messages).toContainEqual(expect.stringContaining('must be a string'));
  });
});
