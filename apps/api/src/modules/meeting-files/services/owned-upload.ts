import { NotFoundException } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';

import { MeetingFileUploadRepository } from './meeting-file-upload.repository';
import type { MeetingFileUploadRecord } from './meeting-file-upload.mapper';
import { requireVisibleMeeting } from './visible-meeting';

/** The one 404 for a session the caller cannot use, whatever the reason. */
export const UPLOAD_NOT_FOUND = 'Upload not found';

/**
 * Resolves the session every chunked route is scoped to, or throws.
 *
 * The meeting is resolved first, exactly as for a file route, so a stranger learns nothing —
 * not even that the upload id is one. Then the session itself: expired, purged, another
 * meeting's, or another user's are one answer. Unlike a file, a session is private to its
 * uploader — the host has no business resuming someone else's upload, and there is nothing
 * to see until it becomes a file.
 */
export async function requireOwnedUpload(
  queryBus: QueryBus,
  uploads: MeetingFileUploadRepository,
  userId: string,
  meetingId: string,
  uploadId: string,
): Promise<MeetingFileUploadRecord> {
  await requireVisibleMeeting(queryBus, userId, meetingId);

  const upload = await uploads.findOwned(meetingId, uploadId, userId);

  if (upload === null) {
    throw new NotFoundException(UPLOAD_NOT_FOUND);
  }

  return upload;
}
