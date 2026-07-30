import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';

import { CreateUserHandler } from './commands/handlers/create-user.handler';
import { FindUserByIdHandler } from './queries/handlers/find-user-by-id.handler';
import { FindUserCredentialsByEmailHandler } from './queries/handlers/find-user-credentials-by-email.handler';

/**
 * Owns the user record: the insert, the lookups, and the public shape. No controller and no
 * routes — nothing about a user is exposed over HTTP yet, and `GET /api/auth/me` is served
 * by the auth module from what its guard already loaded.
 *
 * Nothing is exported either. The buses are the entire surface: a consumer names a command
 * or a query class, never a provider in here, which is what lets `AuthModule` depend on this
 * module's behaviour without importing it.
 */
@Module({
  // Imported per module rather than registered globally, so a module's `imports` states
  // what it actually needs. Every module that dispatches or handles messages repeats this.
  imports: [CqrsModule],
  // `@CommandHandler` and `@QueryHandler` register nothing on their own: a handler missing
  // from this array compiles and throws only when something first dispatches to it.
  providers: [CreateUserHandler, FindUserByIdHandler, FindUserCredentialsByEmailHandler],
})
export class UserModule {}
