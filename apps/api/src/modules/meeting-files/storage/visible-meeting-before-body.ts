import { ParseUUIDPipe, UnauthorizedException } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';

import type { AuthenticatedRequest } from '../../auth/authenticated-request';
import { requireVisibleMeeting } from '../services/visible-meeting';

const UUID_V4 = new ParseUUIDPipe({ version: '4' });

/**
 * The three cheap rejections a route that reads a large body answers before it reads a byte:
 * the 401 `@CurrentUser()` would give, the 400 the param pipe would, and the 404 the handler
 * would — only earlier.
 *
 * Nest runs interceptors before pipes and the handler, so an interceptor that reads the body
 * is otherwise the only thing between a caller and the bytes they send; without this, any
 * signed-in account could make the API take in a whole body against a guessed id and only
 * then be told no. The handler checks visibility again, because its command has to be safe
 * whatever transport dispatched it; the second read is one indexed query against a body the
 * API never had to hold.
 */
export async function requireVisibleMeetingBeforeBody(
  queryBus: QueryBus,
  request: AuthenticatedRequest,
): Promise<void> {
  // The read `@CurrentUser()` performs, with its throw: on a route the guard did not run on,
  // this fails loudly rather than skipping the check.
  const { user } = request;

  if (user === undefined) {
    throw new UnauthorizedException();
  }

  // Express 5 types a param as `string | string[] | undefined`; anything but one string is
  // not a UUID, and the pipe says so with the same 400 it gives the handler.
  const meetingId = await UUID_V4.transform(String(request.params['id'] ?? ''), {
    type: 'param',
    data: 'id',
  });

  await requireVisibleMeeting(queryBus, user.id, meetingId);
}
