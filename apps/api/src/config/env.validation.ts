import { Transform, plainToInstance } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotIn,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  Min,
  MinLength,
  ValidateIf,
  validateSync,
} from 'class-validator';

/**
 * Signing keys this repository has published. Rejected by value because length alone cannot
 * catch them: the placeholder below is 44 characters, so it satisfies `@MinLength(32)` and a
 * deployment that never set `JWT_SECRET` would boot and sign real tokens with a key anybody
 * who has read the repository knows. User ids are not secret — they travel in meeting and
 * file payloads — so that key is an account-takeover primitive, not a weak default.
 */
const PUBLISHED_JWT_SECRETS: readonly string[] = ['dev-only-replace-with-openssl-rand-base64-32'];

const GENERATE_SECRET_ADVICE = 'Generate one with `openssl rand -base64 32`.';

export enum NodeEnv {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

/**
 * Environment contract for the API. Anything the app cannot start without belongs here,
 * so misconfiguration fails at boot rather than at the first request that needs it.
 */
export class EnvironmentVariables {
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @IsInt()
  @Min(1)
  @Max(65_535)
  PORT: number = 3001;

  @IsString()
  @MinLength(1)
  DATABASE_URL: string;

  /** Signs and verifies access tokens. A short secret is a guessable secret, and a published
   *  one is no secret at all — both fail here rather than at the first forged token. */
  @IsString()
  @MinLength(32, {
    message: `JWT_SECRET must be at least 32 characters. ${GENERATE_SECRET_ADVICE}`,
  })
  @IsNotIn(PUBLISHED_JWT_SECRETS, {
    message: `JWT_SECRET is a placeholder published in this repository. ${GENERATE_SECRET_ADVICE}`,
  })
  JWT_SECRET: string;

  /**
   * Access token lifetime. Seconds rather than an `ms`-style string so the bound is a
   * number the contract can police — capped at 30 days, because a token that outlives its
   * user's session is a credential nobody can revoke.
   */
  @IsInt()
  @Min(60)
  @Max(30 * 24 * 60 * 60)
  JWT_EXPIRES_IN_SECONDS: number = 3600;

  /**
   * The window, and the number of credential attempts one client may spend inside it, on
   * `/api/auth` — register, login, and the password change.
   *
   * Two problems share one budget. Password guessing is the obvious one: without a limit the
   * login route is an oracle an attacker may consult for ever. The cheaper one is cost
   * asymmetry — every login attempt spends a full argon2id verification even when no account
   * matches, because `LoginHandler` deliberately hashes a dummy on the miss path to close the
   * timing oracle. That defence turns each tiny unauthenticated POST into ~100ms of
   * memory-hard work on the libuv threadpool, so the request budget is also what keeps a few
   * dozen connections from starving it.
   *
   * Ten a minute is generous for a person and useless to a brute force. The counter is keyed
   * on the socket address, never on a forwarded header — see the note in `auth.module.ts`
   * about what that means behind a proxy.
   */
  @IsInt()
  @Min(1)
  AUTH_RATE_LIMIT_WINDOW_SECONDS: number = 60;

  @IsInt()
  @Min(1)
  AUTH_RATE_LIMIT_ATTEMPTS: number = 10;

  /**
   * Root of meeting file storage, resolved relative to the working directory. Created at boot
   * and checked for writability then, so a bad path fails startup rather than the first upload.
   */
  @IsString()
  @MinLength(1)
  MEETING_FILES_DIR: string = 'storage';

  /**
   * Whether this process runs the file processing worker. Every replica polls when it is on;
   * the API e2e suite turns it off and drives the worker by hand.
   *
   * `enableImplicitConversion` alone would read the string `'false'` as `Boolean('false')`,
   * which is `true` — a worker that cannot be switched off. Hence the explicit parse, which
   * reads the raw string from `obj` because `value` has already been coerced by the time a
   * transform runs; any spelling but the four below is left as-is so `@IsBoolean` rejects it.
   */
  @Transform(({ obj, key }) => parseBoolean((obj as Record<string, unknown>)[key]))
  @IsBoolean()
  MEETING_FILES_WORKER_ENABLED: boolean = true;

  /** How long a claimed file stays owned by one worker before another may retry it. */
  @IsInt()
  @Min(5)
  MEETING_FILES_LEASE_SECONDS: number = 60;

  /** How long the worker sleeps after finding nothing to claim. */
  @IsInt()
  @Min(100)
  MEETING_FILES_POLL_MS: number = 1000;

  /**
   * How long one file event stream stays open before it completes and a client reconnects.
   *
   * Bounded rather than unlimited so a tab left open overnight does not hold a connection
   * for ever, and because the reconnect is what repairs a stream that silently stopped
   * carrying events: the client refetches the list when it reopens. At least thirty seconds,
   * which is two heartbeats — a TTL shorter than that is a reconnect loop.
   */
  @IsInt()
  @Min(30)
  MEETING_FILES_STREAM_TTL_SECONDS: number = 300;

  /**
   * How long a chunked upload session stays open. Past it the session answers 404 and the
   * worker removes its chunks, so this is also the longest an abandoned upload holds disk.
   * At least an hour: a session shorter than the upload it exists to carry is a session that
   * expires under a slow connection.
   */
  @IsInt()
  @Min(1)
  MEETING_FILE_UPLOAD_TTL_HOURS: number = 24;

  /**
   * Whether the pipeline transcribes audio and video. Off by default: it is the one step that
   * calls a third party, and a deployment that has not chosen one must still process files.
   * Parsed like the worker flag, for the same reason.
   *
   * The URL below is validated here whenever this is on, so a process cannot start in a
   * state where every recording would fail.
   */
  @Transform(({ obj, key }) => parseBoolean((obj as Record<string, unknown>)[key]))
  @IsBoolean()
  MEETING_FILES_TRANSCRIPTION_ENABLED: boolean = false;

  /**
   * An OpenAI-compatible `audio/transcriptions` endpoint — hosted or a self-hosted Whisper
   * server, which is what makes the vendor configuration rather than code. Required when the
   * flag is on, and unvalidated when it is off so a deployment that does not transcribe needs
   * no placeholder.
   */
  @ValidateIf((env: EnvironmentVariables) => env.MEETING_FILES_TRANSCRIPTION_ENABLED)
  @IsUrl({ require_tld: false, require_protocol: true, protocols: ['http', 'https'] })
  TRANSCRIPTION_API_URL: string = '';

  /** Sent as a bearer token when set. Optional: a server on a private network may want none. */
  @IsOptional()
  @IsString()
  TRANSCRIPTION_API_KEY?: string;

  /**
   * The `model` field of the request. An OpenAI-compatible endpoint requires one; a
   * self-hosted server usually ignores whatever it is sent, which is why this has a default
   * rather than being required alongside the URL.
   */
  @IsString()
  @MinLength(1)
  TRANSCRIPTION_MODEL: string = 'whisper-1';

  /**
   * How long one transcription may take before it is aborted and the file fails with a
   * specific reason rather than hanging on a lease that keeps being renewed. Ten minutes by
   * default; at least thirty seconds, because a bound shorter than the request it bounds only
   * fails files.
   */
  @IsInt()
  @Min(30)
  TRANSCRIPTION_TIMEOUT_SECONDS: number = 600;
}

function parseBoolean(value: unknown): unknown {
  if (typeof value === 'boolean') {
    return value;
  }

  switch (String(value).trim().toLowerCase()) {
    case 'true':
    case '1':
      return true;
    case 'false':
    case '0':
      return false;
    default:
      return value;
  }
}

export function validate(config: Record<string, unknown>): EnvironmentVariables {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
    exposeDefaultValues: true,
  });

  const errors = validateSync(validated, { skipMissingProperties: false });

  if (errors.length > 0) {
    const details = errors
      .map((error) => `${error.property}: ${Object.values(error.constraints ?? {}).join(', ')}`)
      .join('\n  - ');
    throw new Error(`Invalid environment configuration:\n  - ${details}`);
  }

  return validated;
}
