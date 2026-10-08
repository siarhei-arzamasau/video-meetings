import 'reflect-metadata';

import { validate } from './env.validation';
import { VALID } from './env.validation.fixture';

const TOKEN_MESSAGE = 'ANTHROPIC_AUTH_TOKEN must be set when MEETING_DIGEST_ENABLED is on.';

/** The digest switched on the way a deployment does it: the flag, and a token to pay with. */
const ON = { ...VALID, MEETING_DIGEST_ENABLED: 'true', ANTHROPIC_AUTH_TOKEN: 'a-token' };

/** The digest variables: what boot checks, and what it deliberately does not. */
describe('validate: the meeting digest', () => {
  it('is off unless asked for, with the measured time limit, and needs no token', () => {
    // The feature sends transcript text to a third party, so a deployment that has never
    // heard of it must send nothing — and must still boot.
    const env = validate(VALID);

    expect(env.MEETING_DIGEST_ENABLED).toBe(false);
    expect(env.MEETING_DIGEST_TIMEOUT_SECONDS).toBe(240);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it.each([
    ['false', false],
    ['0', false],
    ['true', true],
    ['1', true],
  ])('reads MEETING_DIGEST_ENABLED=%s as %s', (raw, expected) => {
    // Parsed like the worker flag: implicit conversion alone reads 'false' as true.
    const env = validate({ ...ON, MEETING_DIGEST_ENABLED: raw });

    expect(env.MEETING_DIGEST_ENABLED).toBe(expected);
  });

  it('rejects a MEETING_DIGEST_ENABLED value that is not a boolean spelling', () => {
    expect(() => validate({ ...ON, MEETING_DIGEST_ENABLED: 'yes' })).toThrow(
      /MEETING_DIGEST_ENABLED/,
    );
  });

  it.each([
    ['unset', undefined],
    ['empty, as `.env.example` ships it', ''],
    ['blank', '   '],
  ])('refuses to boot with the digest on and the token %s, naming the variable', (_case, token) => {
    // At boot, as a missing transcription endpoint is — not at the first digest, which would
    // be a Failed digest on every meeting for a reason only the server log gives.
    expect(() => validate({ ...ON, ANTHROPIC_AUTH_TOKEN: token })).toThrow(TOKEN_MESSAGE);
  });

  it('boots with the digest on and a token, and never asks whether Anthropic answers', () => {
    // The token's presence is checked and nothing else: no request leaves at boot, so an
    // unreachable Anthropic fails a digest, not the process that serves every upload.
    const env = validate(ON);

    expect(env.MEETING_DIGEST_ENABLED).toBe(true);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('a-token');
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
  ])('boots with the digest off and the token %s', (_case, token) => {
    expect(() =>
      validate({ ...VALID, MEETING_DIGEST_ENABLED: 'false', ANTHROPIC_AUTH_TOKEN: token }),
    ).not.toThrow();
  });

  it('keeps a token that is set while the digest is off, for whatever else sends a prompt', () => {
    expect(validate({ ...VALID, ANTHROPIC_AUTH_TOKEN: 'a-token' }).ANTHROPIC_AUTH_TOKEN).toBe(
      'a-token',
    );
  });

  it('takes the time limit from the environment, and refuses one under thirty seconds', () => {
    expect(
      validate({ ...ON, MEETING_DIGEST_TIMEOUT_SECONDS: '600' }).MEETING_DIGEST_TIMEOUT_SECONDS,
    ).toBe(600);
    expect(() => validate({ ...ON, MEETING_DIGEST_TIMEOUT_SECONDS: '29' })).toThrow(
      /MEETING_DIGEST_TIMEOUT_SECONDS/,
    );
  });
});
