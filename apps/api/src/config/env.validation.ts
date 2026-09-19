import { Transform, plainToInstance } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsString,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

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

  /** Signs and verifies access tokens. A short secret is a guessable secret. */
  @IsString()
  @MinLength(32)
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
   * How long a chunked upload session stays open. Past it the session answers 404 and the
   * worker removes its chunks, so this is also the longest an abandoned upload holds disk.
   * At least an hour: a session shorter than the upload it exists to carry is a session that
   * expires under a slow connection.
   */
  @IsInt()
  @Min(1)
  MEETING_FILE_UPLOAD_TTL_HOURS: number = 24;
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
