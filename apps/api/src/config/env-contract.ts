import { applyDecorators } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import type { ClassConstructor } from 'class-transformer';
import { IsNotIn, IsString, MinLength, validateSync } from 'class-validator';

import { GENERATE_SECRET_ADVICE, PUBLISHED_JWT_SECRETS } from './env-values';

/**
 * What an environment contract in this package is made of, apart from the contract itself
 * (`env.validation.ts`): the one rule worth a name of its own, and the check that words a
 * refusal. A second process with a contract of its own would be held to both.
 */

const MIN_JWT_SECRET_LENGTH = 32;

/**
 * The rule for the key that signs and verifies access tokens. A short secret is a guessable
 * secret, and a published one is no secret at all — both fail here rather than at the first
 * forged token.
 *
 * One decorator because every process that verifies a token is held to it, not only the one
 * that signs: a verifier started on the placeholder accepts a token anybody can mint.
 */
export const IsJwtSecret = (): PropertyDecorator =>
  applyDecorators(
    IsString(),
    MinLength(MIN_JWT_SECRET_LENGTH, {
      message: `JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters. ${GENERATE_SECRET_ADVICE}`,
    }),
    IsNotIn(PUBLISHED_JWT_SECRETS, {
      message: `JWT_SECRET is a placeholder published in this repository. ${GENERATE_SECRET_ADVICE}`,
    }),
  );

/**
 * The environment as an instance of `contract`, or an error naming every variable that
 * breaks it. `ConfigModule` calls a contract's `validate` as its module is imported and
 * turns the throw into a rejection Nest meets when it compiles the module — so the process
 * refuses to boot, before anything connects to the database.
 */
export function checkedAgainst<T extends object>(
  contract: ClassConstructor<T>,
  config: Record<string, unknown>,
): T {
  const validated = plainToInstance(contract, config, {
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
