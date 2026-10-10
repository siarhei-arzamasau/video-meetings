import 'reflect-metadata';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ConfigModule } from '@nestjs/config';

import { PUBLISHED_JWT_SECRETS } from './env-values';
import { VALID } from './env.validation.fixture';
import { validateMeetingToolsStdio } from './env.validation.meeting-tools-stdio';

const ACCESS_TOKEN = 'header.payload.signature';
/** What the process was started with: the one place the token is read from. */
const STARTED_WITH = { MEETING_TOOLS_ACCESS_TOKEN: ACCESS_TOKEN };

describe('validateMeetingToolsStdio', () => {
  it('takes a database, a signing key and a token, and asks for nothing else of the API', () => {
    // None of what the API's contract adds: no upload directory, no origin, no port.
    expect(validateMeetingToolsStdio(VALID, STARTED_WITH)).toMatchObject({
      ...VALID,
      MEETING_TOOLS_ACCESS_TOKEN: ACCESS_TOKEN,
    });
  });

  it.each(['DATABASE_URL', 'JWT_SECRET'] as const)(
    'refuses an environment with no %s, and names it',
    (variable) => {
      const { [variable]: _omitted, ...rest } = VALID;

      expect(() => validateMeetingToolsStdio(rest, STARTED_WITH)).toThrow(new RegExp(variable));
    },
  );

  it.each([
    ['no token', {}],
    ['a token that is set to nothing', { MEETING_TOOLS_ACCESS_TOKEN: '' }],
  ])('refuses a process started with %s', (_case, startedWith) => {
    expect(() => validateMeetingToolsStdio(VALID, startedWith)).toThrow(
      /MEETING_TOOLS_ACCESS_TOKEN must be set/,
    );
  });

  it('never takes the token from an env file, whatever one holds', () => {
    // `config` is the files under the environment, so a token only there came from a file:
    // read, the server would answer as whoever left it instead of refusing to start.
    const fromFiles = { ...VALID, MEETING_TOOLS_ACCESS_TOKEN: 'a-token-left-in-an-env-file' };

    expect(() => validateMeetingToolsStdio(fromFiles, {})).toThrow(
      /MEETING_TOOLS_ACCESS_TOKEN must be set/,
    );
    expect(validateMeetingToolsStdio(fromFiles, STARTED_WITH).MEETING_TOOLS_ACCESS_TOKEN).toBe(
      ACCESS_TOKEN,
    );
  });

  it("reads the process's own environment when it is handed none", () => {
    const before = process.env['MEETING_TOOLS_ACCESS_TOKEN'];
    process.env['MEETING_TOOLS_ACCESS_TOKEN'] = ACCESS_TOKEN;

    try {
      expect(validateMeetingToolsStdio(VALID).MEETING_TOOLS_ACCESS_TOKEN).toBe(ACCESS_TOKEN);
    } finally {
      if (before === undefined) {
        delete process.env['MEETING_TOOLS_ACCESS_TOKEN'];
      } else {
        process.env['MEETING_TOOLS_ACCESS_TOKEN'] = before;
      }
    }
  });

  it.each([
    ['shorter than the API allows', 'short-secret', /at least 32 characters/],
    ['published in this repository', PUBLISHED_JWT_SECRETS[0], /placeholder published/],
  ])('refuses a signing key %s', (_case, secret, message) => {
    // The API's rule, for a verifier: on a key anybody knows, a token anybody can mint
    // would open any meeting.
    expect(() => validateMeetingToolsStdio({ ...VALID, JWT_SECRET: secret }, STARTED_WITH)).toThrow(
      message,
    );
  });
});

/**
 * The same rule through the real `ConfigModule`, over a real env file. The cases above hand
 * `validate` its environment; this is the one that would notice a release of the library
 * that copied a file's values into `process.env` before it validated — after which a token
 * left in a file would start the server, with every other spec green.
 */
describe('validateMeetingToolsStdio, called by ConfigModule', () => {
  const VARIABLES = ['DATABASE_URL', 'JWT_SECRET', 'MEETING_TOOLS_ACCESS_TOKEN'] as const;
  const before = new Map<string, string | undefined>();
  let directory: string;
  let envFilePath: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-tools-stdio-env-'));
    envFilePath = path.join(directory, '.env');
    fs.writeFileSync(
      envFilePath,
      Object.entries({ ...VALID, MEETING_TOOLS_ACCESS_TOKEN: 'a-token-left-in-an-env-file' })
        .map(([name, value]) => `${name}=${value}`)
        .join('\n'),
    );

    for (const variable of VARIABLES) {
      before.set(variable, process.env[variable]);
      delete process.env[variable];
    }
  });

  afterEach(() => {
    for (const variable of VARIABLES) {
      const value = before.get(variable);

      if (value === undefined) {
        delete process.env[variable];
      } else {
        process.env[variable] = value;
      }
    }

    fs.rmSync(directory, { recursive: true, force: true });
  });

  const configure = (): Promise<unknown> =>
    ConfigModule.forRoot({ envFilePath, validate: validateMeetingToolsStdio });

  it('refuses a process started with no token although its env file holds one', async () => {
    await expect(configure()).rejects.toThrow(/MEETING_TOOLS_ACCESS_TOKEN must be set/);
  });

  it('takes the database and the key from the file, and the token from what it was started with', async () => {
    process.env['MEETING_TOOLS_ACCESS_TOKEN'] = ACCESS_TOKEN;

    await expect(configure()).resolves.toBeDefined();
    expect(process.env['MEETING_TOOLS_ACCESS_TOKEN']).toBe(ACCESS_TOKEN);
    expect(process.env['JWT_SECRET']).toBe(VALID.JWT_SECRET);
  });
});
