import { Transform } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsBoolean,
  IsEnum,
  IsInt,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

import { IsJwtSecret, checkedAgainst } from './env-contract';
import { NodeEnv, ORIGIN_PATTERN, corsOriginsOf, parseBoolean } from './env-values';
import { TranscriptionEnvironmentVariables } from './env.validation.transcription';
import {
  DEFAULT_MEETING_DIGEST_MAX_TOOL_CALLS,
  DEFAULT_MEETING_DIGEST_TIMEOUT_SECONDS,
} from './meeting-digest.defaults';

/**
 * Environment contract for the API. Anything the app cannot start without belongs here,
 * so misconfiguration fails at boot rather than at the first request that needs it.
 *
 * The transcription settings are the class this one extends, in a file of their own: they
 * are one feature's, they are validated together, and this file was at its size limit.
 * Decorators are inherited, so `validate` below checks both as one contract.
 */
export class EnvironmentVariables extends TranscriptionEnvironmentVariables {
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @IsInt()
  @Min(1)
  @Max(65_535)
  PORT: number = 3001;

  @IsString()
  @MinLength(1)
  DATABASE_URL: string;

  /** Signs and verifies access tokens; `IsJwtSecret` is the rule, and why it has one. */
  @IsJwtSecret()
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
   * on the client address, which `TRUST_PROXY_HOPS` below decides.
   */
  @IsInt()
  @Min(1)
  AUTH_RATE_LIMIT_WINDOW_SECONDS: number = 60;

  @IsInt()
  @Min(1)
  AUTH_RATE_LIMIT_ATTEMPTS: number = 10;

  /**
   * How many reverse proxies you control stand in front of the API — Express's `trust proxy`, as
   * a hop count. It decides what `req.ip` is, and so whose budget a credential attempt spends.
   *
   * `0`, the default, trusts none: the client is the socket's address and `X-Forwarded-For` is
   * ignored. That is right for an API exposed directly and wrong behind a proxy, where every
   * client arrives as the proxy and shares one budget — ten requests a minute from anybody would
   * lock everybody out of signing in. Set it to exactly the number of proxies in front, and no
   * more: one hop too many and an address the caller wrote into `X-Forwarded-For` becomes its
   * identity, which hands every request a fresh budget.
   */
  @IsInt()
  @Min(0)
  TRUST_PROXY_HOPS: number = 0;

  /**
   * The browser origins allowed to call the API, comma-separated. No other is named as allowed:
   * a page elsewhere can send a request but never read the answer, nor ride a session once the
   * token is a cookie. Exact origins, as they are compared exactly. Required in
   * production; `corsOriginsOf` says what development gets without it.
   */
  @ArrayNotEmpty({ message: 'CORS_ORIGINS must name the web app origin in production' })
  @Matches(ORIGIN_PATTERN, { each: true, message: 'CORS_ORIGINS entries must be bare origins' })
  CORS_ORIGINS: string[] = [];

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
   * transform runs; any spelling but the four `parseBoolean` knows is left as-is so
   * `@IsBoolean` rejects it.
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
   * Whether a recording that reaches Transcribed asks for its meeting's digest, whether the
   * digest worker claims anything, and whether a boot asks for the digests that are owed.
   * **Off by default, because switching it on sends transcript text to Anthropic** — the
   * first thing in this API to send meeting content to a third party, and on the boot that
   * switches it on, the transcripts of every meeting that has recordings and no current
   * digest. Off, a digest already stored is still served and a queued one waits for the
   * setting to come back. Parsed like the worker flag, for the same reason.
   */
  @Transform(({ obj, key }) => parseBoolean((obj as Record<string, unknown>)[key]))
  @IsBoolean()
  MEETING_DIGEST_ENABLED: boolean = false;

  /**
   * How long one generation may take before it is hung up on and the digest ends Failed with
   * a reason naming this limit. Four minutes by default: twice the slowest generation the
   * measurements beside the constant predict. At least thirty seconds: a bound shorter than
   * the request it bounds only fails digests.
   */
  @IsInt()
  @Min(30)
  MEETING_DIGEST_TIMEOUT_SECONDS: number = DEFAULT_MEETING_DIGEST_TIMEOUT_SECONDS;

  /**
   * How many times one generation may call the meeting's tools — find a task, write one,
   * revise the summary — before a hook refuses every further call and tells the model to
   * answer. The digest is still written; the tasks past the budget are not. At least two,
   * which is one task — a search and a write — and the least the instructions can plan for.
   */
  @IsInt()
  @Min(2)
  MEETING_DIGEST_MAX_TOOL_CALLS: number = DEFAULT_MEETING_DIGEST_MAX_TOOL_CALLS;

  /**
   * What the Claude Agent SDK authenticates with, sent to Anthropic as a bearer token, and
   * the only credential there is: `ClaudeAgentService` refuses a prompt without it rather
   * than let the SDK fall back to one it finds on the host.
   *
   * **Required while the digest is on, and unvalidated while it is off** — the transcription
   * endpoint's rule. Its presence is all that is checked: no request leaves at boot, so a
   * token Anthropic refuses fails a digest, never the process that serves every upload.
   */
  @ValidateIf((env: EnvironmentVariables) => env.MEETING_DIGEST_ENABLED)
  @Matches(/\S/, { message: 'ANTHROPIC_AUTH_TOKEN must be set when MEETING_DIGEST_ENABLED is on.' })
  ANTHROPIC_AUTH_TOKEN?: string;
}

export function validate(config: Record<string, unknown>): EnvironmentVariables {
  // Resolved here, not by a transform: the default depends on two other variables, and a
  // transform runs only for a key the environment set.
  const isProduction = config['NODE_ENV'] === NodeEnv.Production;
  const origins = corsOriginsOf(config['CORS_ORIGINS'], config['WEB_PORT'], isProduction);

  return checkedAgainst(EnvironmentVariables, { ...config, CORS_ORIGINS: origins });
}
