import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';

import { AuthModule } from '../auth/auth.module';
import { DeleteAvatarHandler } from './commands/handlers/delete-avatar.handler';
import { CreateUserHandler } from './commands/handlers/create-user.handler';
import { UpdateDisplayNameHandler } from './commands/handlers/update-display-name.handler';
import { UpdatePasswordHashHandler } from './commands/handlers/update-password-hash.handler';
import { UploadAvatarHandler } from './commands/handlers/upload-avatar.handler';
import { FindUserByIdHandler } from './queries/handlers/find-user-by-id.handler';
import { FindUserCredentialsByEmailHandler } from './queries/handlers/find-user-credentials-by-email.handler';
import { FindUserCredentialsByIdHandler } from './queries/handlers/find-user-credentials-by-id.handler';
import { AvatarImage } from './services/avatar-image';
import { AvatarService } from './services/avatar.service';
import { AvatarStorage } from './storage/avatar-storage';
import { AvatarUploadInterceptor } from './storage/avatar-upload.interceptor';
import { UserController } from './user.controller';

/**
 * Owns the user record: the insert, the lookups, the public shape, the avatar's bytes, and the
 * routes that change a user's own profile. `GET /api/auth/me` stays in the auth module, served by what its guard
 * already loaded.
 *
 * Nothing is exported. The buses are the entire surface for other modules: a consumer names a
 * command or a query class, never a provider in here, which is what lets `AuthModule` depend
 * on this module's behaviour without importing it. `AuthModule` appears below only because
 * `UserController` needs `JwtAuthGuard`, exactly as the meetings modules do — the dependency
 * runs this way and never the other, so the bus-only boundary auth relies on is untouched.
 */
@Module({
  // Imported per module rather than registered globally, so a module's `imports` states
  // what it actually needs. Every module that dispatches or handles messages repeats this.
  imports: [CqrsModule, AuthModule],
  controllers: [UserController],
  // `@CommandHandler` and `@QueryHandler` register nothing on their own: a handler missing
  // from this array compiles and throws only when something first dispatches to it.
  providers: [
    CreateUserHandler,
    UpdateDisplayNameHandler,
    UpdatePasswordHashHandler,
    UploadAvatarHandler,
    DeleteAvatarHandler,
    FindUserByIdHandler,
    FindUserCredentialsByEmailHandler,
    FindUserCredentialsByIdHandler,
    // Not handlers: the avatar's collaborators. `AvatarStorage` creates and probes its
    // directory at boot, and `AvatarUploadInterceptor` is a provider rather than a decorator
    // because it needs that storage injected.
    AvatarStorage,
    AvatarImage,
    AvatarService,
    AvatarUploadInterceptor,
  ],
})
export class UserModule {}
