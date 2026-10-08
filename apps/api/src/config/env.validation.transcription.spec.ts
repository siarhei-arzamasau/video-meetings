import 'reflect-metadata';

import { validate } from './env.validation';
import { VALID } from './env.validation.fixture';

/** What `docker-compose.yml` hands the `api` service when nothing overrides it. */
const COMPOSE_WHISPER_URL = 'http://whisper:8000/v1/audio/transcriptions';

/** Transcription switched on the way the documented local set-up does it. */
const ON = {
  ...VALID,
  MEETING_FILES_TRANSCRIPTION_ENABLED: 'true',
  TRANSCRIPTION_API_URL: 'http://localhost:8000/v1/audio/transcriptions',
  TRANSCRIPTION_MODEL: 'Systran/faster-whisper-small',
};

/** The transcription variables: what boot checks, and what it deliberately does not. */
describe('validate: transcription', () => {
  it('boots with transcription off and no endpoint configured', () => {
    // The whole point of the flag: a deployment that does not transcribe needs no placeholder
    // URL, and the URL is not validated while nothing reads it.
    expect(() =>
      validate({ ...VALID, MEETING_FILES_TRANSCRIPTION_ENABLED: 'false' }),
    ).not.toThrow();
  });

  it('boots with no transcription variable present at all, and transcribes nothing', () => {
    // A deployment that has never heard of Whisper: not the flag, not the URL, not the model.
    const env = validate(VALID);

    expect(env.MEETING_FILES_TRANSCRIPTION_ENABLED).toBe(false);
    expect(env.TRANSCRIPTION_API_URL).toBe('');
    expect(env.TRANSCRIPTION_API_KEY).toBeUndefined();
  });

  it('has no default model, because no one name is right for every endpoint', () => {
    // The local service answers 404 for a model it has not downloaded, a hosted endpoint for
    // one it does not have. A default would fail every recording on one of them, after boot.
    expect(validate(VALID).TRANSCRIPTION_MODEL).toBe('');
    expect(validate({ ...ON, TRANSCRIPTION_MODEL: 'whisper-1' }).TRANSCRIPTION_MODEL).toBe(
      'whisper-1',
    );
  });

  it.each([
    ['unset', undefined],
    ['blank', ''],
  ])(
    'refuses to boot with transcription on and the model %s, naming the variable',
    (_case, model) => {
      expect(() => validate({ ...ON, TRANSCRIPTION_MODEL: model })).toThrow(
        'TRANSCRIPTION_MODEL must be set when MEETING_FILES_TRANSCRIPTION_ENABLED is on.',
      );
    },
  );

  it.each([
    ['the local service, stopped', 'http://localhost:8000/v1/audio/transcriptions'],
    ['the Compose service, by a name this host cannot resolve', COMPOSE_WHISPER_URL],
  ])('boots with transcription on and %s', (_description, url) => {
    // Boot checks the shape of the URL and never the server behind it: nothing listens on
    // either address while this suite runs. Whisper being down fails a transcription, not
    // the process that also serves every upload and download.
    const env = validate({ ...ON, TRANSCRIPTION_API_URL: url });

    expect(env.MEETING_FILES_TRANSCRIPTION_ENABLED).toBe(true);
    expect(env.TRANSCRIPTION_API_URL).toBe(url);
  });

  it('refuses to boot with transcription on and no endpoint', () => {
    expect(() => validate({ ...ON, TRANSCRIPTION_API_URL: undefined })).toThrow(
      /TRANSCRIPTION_API_URL/,
    );
  });

  it('refuses a transcription endpoint that is not an http(s) URL', () => {
    expect(() =>
      validate({ ...ON, TRANSCRIPTION_API_URL: 'localhost:9000/v1/audio/transcriptions' }),
    ).toThrow(/TRANSCRIPTION_API_URL/);
  });

  it('accepts transcription on with an endpoint, and the key stays optional', () => {
    const env = validate({ ...ON, TRANSCRIPTION_TIMEOUT_SECONDS: '60' });

    expect(env.MEETING_FILES_TRANSCRIPTION_ENABLED).toBe(true);
    expect(env.TRANSCRIPTION_API_KEY).toBeUndefined();
    expect(env.TRANSCRIPTION_TIMEOUT_SECONDS).toBe(60);
  });

  it('rejects a transcription timeout under thirty seconds', () => {
    expect(() => validate({ ...ON, TRANSCRIPTION_TIMEOUT_SECONDS: '29' })).toThrow(
      /TRANSCRIPTION_TIMEOUT_SECONDS/,
    );
  });
});
