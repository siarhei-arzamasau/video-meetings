import { IsString, MinLength } from 'class-validator';

import { IsJwtSecret, checkedAgainst } from './env-contract';

/** The variable the stdio server's client hands it its user's access token in. */
export const MEETING_TOOLS_ACCESS_TOKEN_VARIABLE = 'MEETING_TOOLS_ACCESS_TOKEN';

/**
 * The environment contract of the meeting tools' stdio server
 * (`src/meeting-tools-stdio.main.ts`) — a process of its own, and not the API's contract:
 * that one would refuse a task search over an upload directory or a CORS origin it never
 * touches. These three are everything it reads.
 */
export class MeetingToolsStdioEnvironmentVariables {
  @IsString()
  @MinLength(1)
  DATABASE_URL: string;

  /**
   * The key the API signs access tokens with, which this process verifies its user's with.
   * Held to the API's rule: on the published placeholder it would take a token anybody who
   * has read this repository can mint, for any user.
   */
  @IsJwtSecret()
  JWT_SECRET: string;

  /**
   * The access token of the user the server answers for: what `POST /api/auth/login`
   * responds with. **The environment and never the command line**, which every process on
   * the host can read. Only its presence is checked here; whether it verifies, and whether
   * its user may read the meeting, is decided once the process is up — and again on every
   * call.
   */
  @IsString()
  @MinLength(1, {
    message: `${MEETING_TOOLS_ACCESS_TOKEN_VARIABLE} must be set, in the environment the server is started with, to the access token of the user it answers for`,
  })
  MEETING_TOOLS_ACCESS_TOKEN: string;
}

/**
 * `config` is what `ConfigModule` read: the env files, under the environment.
 *
 * **The token is taken from `environment` alone — what the process was started with — and
 * never from a file.** The database and the key are the deployment's and belong in its env
 * files; the token is one user's, handed over by their client. Read from a file as well, a
 * server started with no token would not refuse: it would answer as whoever left one there.
 * It works because `ConfigModule` calls this before it copies anything it read from a file
 * into `process.env`.
 */
export function validateMeetingToolsStdio(
  config: Record<string, unknown>,
  environment: Record<string, string | undefined> = process.env,
): MeetingToolsStdioEnvironmentVariables {
  return checkedAgainst(MeetingToolsStdioEnvironmentVariables, {
    ...config,
    [MEETING_TOOLS_ACCESS_TOKEN_VARIABLE]: environment[MEETING_TOOLS_ACCESS_TOKEN_VARIABLE],
  });
}
