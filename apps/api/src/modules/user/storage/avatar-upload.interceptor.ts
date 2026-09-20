import { rm } from 'node:fs/promises';

import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  PayloadTooLargeException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { MAX_AVATAR_SIZE_BYTES, AVATAR_SIZE_MESSAGE } from '@repo/shared';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import type { Request } from 'express';
import { diskStorage } from 'multer';
import { Observable, from } from 'rxjs';
import { catchError } from 'rxjs/operators';

import { AvatarStorage } from './avatar-storage';

export const AVATAR_FIELD = 'avatar';

/**
 * `FileInterceptor('avatar')` with the two things it cannot do on its own.
 *
 * It needs the injected storage for its temp directory, which the decorator form cannot reach,
 * so the multer interceptor is built here at construction.
 *
 * And once multer has written a temp file, anything that fails later in the chain would leave
 * it behind; the `catchError` removes it. Multer's own size rejection is mapped to the shared
 * copy on the way past, so an over-size upload reads the same sentence the browser would have
 * shown for it.
 *
 * Unlike `MeetingFileUploadInterceptor` there is nothing to resolve before the body is read:
 * guards run before interceptors, so `JwtAuthGuard` has already established who the caller is,
 * and an avatar has no second resource to be visible in. `fileSize` bounds what an
 * authenticated account can make the server write, which for 5 MB is bound enough.
 */
@Injectable()
export class AvatarUploadInterceptor implements NestInterceptor {
  private readonly multer: NestInterceptor;

  constructor(storage: AvatarStorage) {
    const Multer = FileInterceptor(AVATAR_FIELD, avatarMulterOptions(storage));

    this.multer = new Multer();
  }

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<Request>();

    let stream: Observable<unknown>;

    try {
      stream = await this.multer.intercept(context, next);
    } catch (error) {
      await removeTempFile(request);

      if (error instanceof PayloadTooLargeException) {
        throw new PayloadTooLargeException(AVATAR_SIZE_MESSAGE);
      }

      throw error;
    }

    return stream.pipe(
      catchError((error: unknown) =>
        from(
          removeTempFile(request).then(() => {
            throw error;
          }),
        ),
      ),
    );
  }
}

/**
 * Multipart arrives on disk, not in memory. The temp directory is under the avatar storage
 * root, so the later rename into place is atomic.
 *
 * No `fileFilter` for the type: the file has to be on disk to decode it, and decoding is the
 * type check. `fileSize` is the only limit multer enforces, and it surfaces as a
 * `PayloadTooLargeException` that the interceptor above maps to the shared sentence.
 */
export function avatarMulterOptions(storage: AvatarStorage): MulterOptions {
  return {
    storage: diskStorage({ destination: storage.tempDir() }),
    limits: { fileSize: MAX_AVATAR_SIZE_BYTES, files: 1, fields: 0 },
  };
}

/** Idempotent, and the handler's own cleanup already removed it on most paths. */
async function removeTempFile(request: Request): Promise<void> {
  const tempPath = request.file?.path;

  if (tempPath !== undefined) {
    await rm(tempPath, { force: true });
  }
}
