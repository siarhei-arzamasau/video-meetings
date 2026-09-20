import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import type { AuthResponse, User } from '@repo/shared';

import { ChangePasswordCommand } from './commands/change-password.command';
import { LoginCommand } from './commands/login.command';
import { RegisterCommand } from './commands/register.command';
import { CurrentUser } from './current-user.decorator';
import { ChangePasswordDto } from './dto/change-password.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { JwtAuthGuard } from './jwt-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly commandBus: CommandBus) {}

  @Post('register')
  register(@Body() { email, password }: RegisterDto): Promise<AuthResponse> {
    return this.commandBus.execute<RegisterCommand, AuthResponse>(
      new RegisterCommand(email, password),
    );
  }

  /** 200, not the 201 Nest gives a POST by default: logging in creates nothing. */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() { email, password }: LoginDto): Promise<AuthResponse> {
    return this.commandBus.execute<LoginCommand, AuthResponse>(new LoginCommand(email, password));
  }

  /**
   * Rotates the caller's password. `PATCH` on the credential rather than a `POST` to a verb:
   * the request changes one property of an existing thing.
   *
   * 204, because there is nothing to answer with. The token the caller is holding keeps
   * working — it is stateless and carries no password — and so does every other token issued
   * for this account, until `JWT_EXPIRES_IN_SECONDS` elapses. The edit page says so next to
   * the form; see `docs/specs/2026-09-20-user-profile-prd.md` for why that is the agreed
   * mitigation rather than a revocation list.
   *
   * The password lives here and the display name lives in `user` because this module owns
   * credentials and that one owns the record — the split the two modules exist to draw.
   */
  @Patch('password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  changePassword(
    @CurrentUser() user: User,
    @Body() { currentPassword, newPassword }: ChangePasswordDto,
  ): Promise<void> {
    return this.commandBus.execute<ChangePasswordCommand, void>(
      new ChangePasswordCommand(user.id, currentPassword, newPassword),
    );
  }

  /** Served entirely by the guard: it loads the user, this returns it. No bus involved. */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: User): User {
    return user;
  }
}
