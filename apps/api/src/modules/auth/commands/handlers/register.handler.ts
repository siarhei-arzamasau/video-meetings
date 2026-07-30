import { CommandBus, CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import type { AuthResponse, User } from '@repo/shared';

import { CreateUserCommand } from '../../../user/commands/create-user.command';
import { PasswordService } from '../../services/password.service';
import { TokenService } from '../../services/token.service';
import { RegisterCommand } from '../register.command';

/**
 * Registration is two concerns meeting: this module turns a password into a hash and an id
 * into a token, and the user module owns the row in between. The only thing that crosses the
 * boundary is a command class — this handler holds no reference to a user-module provider.
 */
@CommandHandler(RegisterCommand)
export class RegisterHandler implements ICommandHandler<RegisterCommand, AuthResponse> {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
  ) {}

  async execute({ email, password }: RegisterCommand): Promise<AuthResponse> {
    const passwordHash = await this.passwords.hash(password);

    // No `try`/`catch` for the taken address: the 409 comes from `CreateUserHandler`, which
    // owns the insert and is the only place that can answer authoritatively. There is
    // nothing for this handler to add on the way past.
    const user = await this.commandBus.execute<CreateUserCommand, User>(
      new CreateUserCommand(email, passwordHash),
    );

    return this.tokens.issueToken(user.id);
  }
}
