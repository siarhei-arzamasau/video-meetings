import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import type { AuthResponse, User } from '@repo/shared';

import { AuthService } from './auth.service';
import { RegisterCommand } from './commands/register.command';
import { CurrentUser } from './current-user.decorator';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { JwtAuthGuard } from './jwt-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly commandBus: CommandBus,
  ) {}

  @Post('register')
  register(@Body() { email, password }: RegisterDto): Promise<AuthResponse> {
    return this.commandBus.execute<RegisterCommand, AuthResponse>(
      new RegisterCommand(email, password),
    );
  }

  /** 200, not the 201 Nest gives a POST by default: logging in creates nothing. */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() credentials: LoginDto): Promise<AuthResponse> {
    return this.auth.login(credentials);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: User): User {
    return user;
  }
}
