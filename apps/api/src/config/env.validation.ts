import { plainToInstance } from 'class-transformer';
import { IsEnum, IsInt, IsString, Max, Min, MinLength, validateSync } from 'class-validator';

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
}

export function validate(config: Record<string, unknown>): EnvironmentVariables {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
    exposeDefaultValues: true,
  });

  const errors = validateSync(validated, { skipMissingProperties: false });

  if (errors.length > 0) {
    const details = errors
      .map((error) => Object.values(error.constraints ?? {}).join(', '))
      .join('\n  - ');
    throw new Error(`Invalid environment configuration:\n  - ${details}`);
  }

  return validated;
}
