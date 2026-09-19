import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import type { MeetingFileUpload, User } from '@repo/shared';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateUploadCommand } from './commands/create-upload.command';
import { CHUNK_INDEX_MESSAGE } from './commands/handlers/store-chunk.handler';
import { StoreChunkCommand } from './commands/store-chunk.command';
import { CreateUploadDto } from './dto/create-upload.dto';
import { MeetingFileUploadsService } from './services/meeting-file-uploads.service';

const UUID_V4 = new ParseUUIDPipe({ version: '4' });

/** The canonical decimal form, the same one the storage key accepts. */
const CHUNK_INDEX = /^(0|[1-9]\d{0,8})$/;

/**
 * Chunked upload, for files over the single-request cap. Its own controller rather than more
 * routes on `MeetingFilesController`, because none of these paths is a file: until `complete`
 * runs there is no `MeetingFile` to list, download, or delete.
 *
 * Registered before `MeetingFilesController` in the module, so `files/uploads/...` is matched
 * as a session and never as a file id.
 */
@Controller('meetings/:id/files/uploads')
@UseGuards(JwtAuthGuard)
export class MeetingFileUploadsController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly uploads: MeetingFileUploadsService,
  ) {}

  /** Opens a session for a declared name and size, and answers with the chunk plan. */
  @Post()
  create(
    @CurrentUser() user: User,
    @Param('id', UUID_V4) meetingId: string,
    @Body() dto: CreateUploadDto,
  ): Promise<MeetingFileUpload> {
    return this.commandBus.execute<CreateUploadCommand, MeetingFileUpload>(
      new CreateUploadCommand(user.id, meetingId, dto.name, dto.size),
    );
  }

  /** What the client asks on resume: which chunks the server already has. */
  @Get(':uploadId')
  findOne(
    @CurrentUser() user: User,
    @Param('id', UUID_V4) meetingId: string,
    @Param('uploadId', UUID_V4) uploadId: string,
  ): Promise<MeetingFileUpload> {
    return this.uploads.findOne(user.id, meetingId, uploadId);
  }

  /**
   * One chunk, as a raw body. The module's middleware has already parsed it into a `Buffer`
   * with a one-chunk limit, so a body larger than that never reaches here.
   *
   * 204 and no body: the client learns nothing from a chunk it did not already know, and the
   * status route is there for the set. The index is parsed here rather than by `ParseIntPipe`
   * so that every unusable index — a word, a negative, a leading zero, one past the end — is
   * the one message the contract names.
   */
  @Put(':uploadId/chunks/:index')
  @HttpCode(204)
  storeChunk(
    @CurrentUser() user: User,
    @Param('id', UUID_V4) meetingId: string,
    @Param('uploadId', UUID_V4) uploadId: string,
    @Param('index') index: string,
    @Body() body: unknown,
  ): Promise<void> {
    if (!CHUNK_INDEX.test(index)) {
      throw new BadRequestException(CHUNK_INDEX_MESSAGE);
    }

    return this.commandBus.execute<StoreChunkCommand, void>(
      new StoreChunkCommand(user.id, meetingId, uploadId, Number(index), asBuffer(body)),
    );
  }
}

/**
 * The raw body, or an empty buffer. Anything but a `Buffer` means the middleware did not run
 * — a route registered without it, a content type it was not given — and an empty chunk is
 * rejected by the length check, which is the same answer a truncated one gets.
 */
function asBuffer(body: unknown): Buffer {
  return Buffer.isBuffer(body) ? body : Buffer.alloc(0);
}
