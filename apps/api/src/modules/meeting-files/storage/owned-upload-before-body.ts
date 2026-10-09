import { QueryBus } from '@nestjs/cqrs';

import type { AuthenticatedRequest } from '../../auth/authenticated-request';
import type { MeetingFileUploadRecord } from '../services/meeting-file-upload.mapper';
import { MeetingFileUploadRepository } from '../services/meeting-file-upload.repository';
import { requireOwnedUpload } from '../services/owned-upload';
import { callerOf, uuidParamOf } from './visible-meeting-before-body';

/**
 * `requireVisibleMeetingBeforeBody` taken one step further, for the route whose body belongs to
 * a session: the caller's own live session, or the rejection the handler would give — the 401,
 * the pipes' 400s, the meeting's 404, the session's 404 — before a byte of the body is read.
 *
 * The meeting alone is not enough here. Anyone can create a meeting, so "may see the meeting"
 * is true of every account for a meeting of its own, and a chunk's worth of memory per
 * connection was then one made-up session id away. The session is what says a chunk is
 * expected at all, and how long it may be.
 *
 * The handler resolves the session again, for the reason it resolves the meeting again: its
 * command has to be safe whatever dispatched it.
 */
export async function requireOwnedUploadBeforeBody(
  queryBus: QueryBus,
  uploads: MeetingFileUploadRepository,
  request: AuthenticatedRequest,
): Promise<MeetingFileUploadRecord> {
  const user = callerOf(request);
  const meetingId = await uuidParamOf(request, 'id');
  const uploadId = await uuidParamOf(request, 'uploadId');

  return requireOwnedUpload(queryBus, uploads, user.id, meetingId, uploadId);
}
