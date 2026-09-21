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
    expect(env.MEETING_FILES_TRANSCRIPTION_ENABLED).toBe(false);
    expect(env.TRANSCRIPTION_TIMEOUT_SECONDS).toBe(600);
  });

  it('boots with transcription off and no endpoint configured', () => {
    // The whole point of the flag: a deployment that does not transcribe needs no placeholder
    // URL, and the URL is not validated while nothing reads it.
    expect(() =>
      validate({ ...VALID, MEETING_FILES_TRANSCRIPTION_ENABLED: 'false' }),
    ).not.toThrow();
  });

  it('refuses to boot with transcription on and no endpoint', () => {
    expect(() => validate({ ...VALID, MEETING_FILES_TRANSCRIPTION_ENABLED: 'true' })).toThrow(
      /TRANSCRIPTION_API_URL/,
    );
  });

  it('refuses a transcription endpoint that is not an http(s) URL', () => {
    expect(() =>
      validate({
        ...VALID,
        MEETING_FILES_TRANSCRIPTION_ENABLED: 'true',
        TRANSCRIPTION_API_URL: 'localhost:9000/v1/audio/transcriptions',
      }),
    ).toThrow(/TRANSCRIPTION_API_URL/);
  });

  it('accepts transcription on with an endpoint, and the key stays optional', () => {
    const env = validate({
      ...VALID,
      MEETING_FILES_TRANSCRIPTION_ENABLED: 'true',
      TRANSCRIPTION_API_URL: 'http://localhost:9000/v1/audio/transcriptions',
      TRANSCRIPTION_TIMEOUT_SECONDS: '60',
    });

    expect(env.MEETING_FILES_TRANSCRIPTION_ENABLED).toBe(true);
    expect(env.TRANSCRIPTION_API_KEY).toBeUndefined();
    expect(env.TRANSCRIPTION_TIMEOUT_SECONDS).toBe(60);
  });

  it('rejects a transcription timeout under thirty seconds', () => {
    expect(() =>
      validate({
        ...VALID,
        MEETING_FILES_TRANSCRIPTION_ENABLED: 'true',
        TRANSCRIPTION_API_URL: 'http://localhost:9000/v1/audio/transcriptions',
        TRANSCRIPTION_TIMEOUT_SECONDS: '29',
      }),
    ).toThrow(/TRANSCRIPTION_TIMEOUT_SECONDS/);
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
      MEETING_FILE_UPLOAD_TTL_HOURS: '6',
    });

    expect(env.MEETING_FILES_LEASE_SECONDS).toBe(30);
    expect(env.MEETING_FILES_POLL_MS).toBe(250);
    expect(env.MEETING_FILE_UPLOAD_TTL_HOURS).toBe(6);
  });

  it('defaults the upload session lifetime to a day and rejects one under an hour', () => {
    expect(validate({ ...VALID }).MEETING_FILE_UPLOAD_TTL_HOURS).toBe(24);
    expect(() => validate({ ...VALID, MEETING_FILE_UPLOAD_TTL_HOURS: '0' })).toThrow(
      /MEETING_FILE_UPLOAD_TTL_HOURS/,
    );
  });
  describe('JWT_SECRET', () => {
    it('rejects the placeholder this repository publishes', () => {
      // The reason length alone is not the rule: this value is 44 characters, so it satisfies
      // `@MinLength(32)`. A deployment that never set the variable used to boot on it and sign
      // real tokens with a key that is in git — anyone could then mint one for any user id.
      expect(() =>
        validate({ ...VALID, JWT_SECRET: 'dev-only-replace-with-openssl-rand-base64-32' }),
      ).toThrow(/JWT_SECRET/);
    });

    it('says what to do about it', () => {
      expect(() =>
        validate({ ...VALID, JWT_SECRET: 'dev-only-replace-with-openssl-rand-base64-32' }),
      ).toThrow(/openssl rand -base64 32/);
    });

    it('rejects a secret under 32 characters', () => {
      expect(() => validate({ ...VALID, JWT_SECRET: 'too-short' })).toThrow(/JWT_SECRET/);
    });

    it('rejects an unset secret, which is what compose now passes when nobody set one', () => {
      expect(() => validate({ ...VALID, JWT_SECRET: '' })).toThrow(/JWT_SECRET/);
    });
  });

  describe('the auth rate limit', () => {
    it('defaults to ten attempts a minute', () => {
      const env = validate(VALID);

      expect(env.AUTH_RATE_LIMIT_WINDOW_SECONDS).toBe(60);
      expect(env.AUTH_RATE_LIMIT_ATTEMPTS).toBe(10);
    });

    it('rejects a budget or a window of zero, which would be no limit or no window', () => {
      expect(() => validate({ ...VALID, AUTH_RATE_LIMIT_ATTEMPTS: '0' })).toThrow(
        /AUTH_RATE_LIMIT_ATTEMPTS/,
      );
      expect(() => validate({ ...VALID, AUTH_RATE_LIMIT_WINDOW_SECONDS: '0' })).toThrow(
        /AUTH_RATE_LIMIT_WINDOW_SECONDS/,
      );
    });
  });

  describe('CORS_ORIGINS', () => {
    it('defaults outside production to the web app pnpm dev runs, on its default port', () => {
      expect(validate(VALID).CORS_ORIGINS).toEqual([
        'http://localhost:3000',
        'http://127.0.0.1:3000',
      ]);
    });

    it('follows WEB_PORT, which the dev script moves when 3000 is taken', () => {
      expect(validate({ ...VALID, WEB_PORT: '3002' }).CORS_ORIGINS).toEqual([
        'http://localhost:3002',
        'http://127.0.0.1:3002',
      ]);
    });

    it('reads a comma-separated list, trimmed, and treats a blank one as unset', () => {
      expect(
        validate({ ...VALID, CORS_ORIGINS: ' https://meet.example.com , http://localhost:3100 ' })
          .CORS_ORIGINS,
      ).toEqual(['https://meet.example.com', 'http://localhost:3100']);
      expect(validate({ ...VALID, CORS_ORIGINS: '  ' }).CORS_ORIGINS).toHaveLength(2);
    });

    it('refuses to boot in production without one, rather than guess what to allow', () => {
      expect(() => validate({ ...VALID, NODE_ENV: 'production' })).toThrow(/CORS_ORIGINS/);
      expect(
        validate({ ...VALID, NODE_ENV: 'production', CORS_ORIGINS: 'https://meet.example.com' })
          .CORS_ORIGINS,
      ).toEqual(['https://meet.example.com']);
    });

    it.each([
      ['no scheme', 'meet.example.com'],
      ['a path', 'https://meet.example.com/app'],
      ['a trailing slash', 'https://meet.example.com/'],
      ['a scheme browsers never send', 'ftp://meet.example.com'],
    ])('refuses an entry with %s, which would match no request', (_description, origin) => {
      expect(() => validate({ ...VALID, CORS_ORIGINS: origin })).toThrow(/CORS_ORIGINS/);
    });
  });

  describe('TRUST_PROXY_HOPS', () => {
    it('trusts no proxy unless told to, so a forwarded header cannot choose the client', () => {
      expect(validate(VALID).TRUST_PROXY_HOPS).toBe(0);
    });

    it('reads a hop count from the environment string', () => {
      expect(validate({ ...VALID, TRUST_PROXY_HOPS: '1' }).TRUST_PROXY_HOPS).toBe(1);
    });

    it.each(['-1', '1.5', 'true'])('rejects %s, which is not a number of proxies', (hops) => {
      expect(() => validate({ ...VALID, TRUST_PROXY_HOPS: hops })).toThrow(/TRUST_PROXY_HOPS/);
    });
  });
});
