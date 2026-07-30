import { UnauthorizedException } from '@nestjs/common';
import { CommandHandler, ICommandHandler, QueryBus } from '@nestjs/cqrs';
import type { AuthResponse } from '@repo/shared';

import {
  FindUserCredentialsByEmailQuery,
  UserCredentials,
} from '../../../user/queries/find-user-credentials-by-email.query';
import { PasswordService } from '../../services/password.service';
import { TokenService } from '../../services/token.service';
import { LoginCommand } from '../login.command';

/**
 * One message for every login failure. A distinct "no such user" would turn this endpoint
 * into an account-enumeration oracle.
 */
const INVALID_CREDENTIALS = 'Invalid email or password';

@CommandHandler(LoginCommand)
export class LoginHandler implements ICommandHandler<LoginCommand, AuthResponse> {
  constructor(
    private readonly queryBus: QueryBus,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
  ) {}

  async execute({ email, password }: LoginCommand): Promise<AuthResponse> {
    // The user module answers what the stored hash is; deciding what a miss means, and making
    // a miss cost what a hit costs, stays here. Both halves of the enumeration defence below
    // are this handler's, which is why the query returns `null` rather than throwing.
    const user = await this.queryBus.execute<
      FindUserCredentialsByEmailQuery,
      UserCredentials | null
    >(new FindUserCredentialsByEmailQuery(email));

    if (user === null) {
      // Costs what a real verification costs, so the response time does not reveal that
      // no account matched.
      await this.passwords.verifyDummy(password);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    if (!(await this.passwords.verify(user.passwordHash, password))) {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    return this.tokens.issueToken(user.id);
  }
}
