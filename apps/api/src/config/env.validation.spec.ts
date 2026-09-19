import 'reflect-metadata';

import { validate } from './env.validation';

const VALID = {
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5433/video_meetings',
  JWT_SECRET: 'a-secret-that-is-at-least-thirty-two-characters',
};

describe('validate', () => {
  it('applies the defaults for everything optional', () => {
    const env = validate(VALID);

    expect(env.PORT).toBe(3001);
    expect(env.MEETING_FILES_DIR).toBe('storage');
    expect(env.MEETING_FILES_WORKER_ENABLED).toBe(true);
    expect(env.MEETING_FILES_LEASE_SECONDS).toBe(60);
    expect(env.MEETING_FILES_POLL_MS).toBe(1000);
  });

  it.each([
    ['false', false],
    ['0', false],
    ['true', true],
    ['1', true],
  ])('reads MEETING_FILES_WORKER_ENABLED=%s as %s', (raw, expected) => {
    // `enableImplicitConversion` alone turns the string 'false' into `Boolean('false')`, which
    // is `true` — a worker that cannot be switched off. The explicit transform is what this pins.
    expect(
      validate({ ...VALID, MEETING_FILES_WORKER_ENABLED: raw }).MEETING_FILES_WORKER_ENABLED,
    ).toBe(expected);
  });

  it('rejects a MEETING_FILES_WORKER_ENABLED value that is not a boolean spelling', () => {
    expect(() => validate({ ...VALID, MEETING_FILES_WORKER_ENABLED: 'yes' })).toThrow(
      /MEETING_FILES_WORKER_ENABLED/,
    );
  });

  it('rejects an empty MEETING_FILES_DIR', () => {
    expect(() => validate({ ...VALID, MEETING_FILES_DIR: '' })).toThrow(/MEETING_FILES_DIR/);
  });

  it('rejects a lease shorter than five seconds and a poll faster than 100 ms', () => {
    expect(() => validate({ ...VALID, MEETING_FILES_LEASE_SECONDS: '4' })).toThrow(
      /MEETING_FILES_LEASE_SECONDS/,
    );
    expect(() => validate({ ...VALID, MEETING_FILES_POLL_MS: '99' })).toThrow(
      /MEETING_FILES_POLL_MS/,
    );
  });

  it('converts numeric strings, which is how every variable arrives from the environment', () => {
    const env = validate({
      ...VALID,
      MEETING_FILES_LEASE_SECONDS: '30',
      MEETING_FILES_POLL_MS: '250',
    });

    expect(env.MEETING_FILES_LEASE_SECONDS).toBe(30);
    expect(env.MEETING_FILES_POLL_MS).toBe(250);
  });
});
