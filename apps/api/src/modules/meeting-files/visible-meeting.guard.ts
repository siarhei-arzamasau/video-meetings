import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import type { Request } from 'express';

import type { AuthenticatedRequest } from '../auth/authenticated-request';
import { requireVisibleMeeting } from './services/visible-meeting';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The visibility check every other route in this module makes inside its handler, hoisted
 * into a guard — **because a streaming route cannot make it in the handler**.
 *
 * Nest commits an SSE response's headers one macrotask after it subscribes, so that a client
 * learns the stream is open without waiting for the first event. Anything the handler awaits
 * after that — a query, which is a round trip to Postgres — loses the race: the 200 and
 * `content-type: text/event-stream` are already on the wire, and the `NotFoundException`
 * arrives too late to become a status code. It is written into the open stream as an
 * `event: error` instead, and a stranger is answered 200.
 *
 * A guard runs before any of that machinery, so the 404 goes out as an ordinary response
 * through `HttpExceptionFilter`, exactly as it does on `GET :id/files`.
 *
 * **A malformed id is left alone on purpose.** `ParseUUIDPipe` answers those with a 400, and
 * it runs after this; dispatching a non-UUID at the query would make Postgres raise on a
 * `uuid` column. Returning `true` here hands the request to the pipe, whose throw is
 * synchronous and therefore does not race the headers the way an awaited query does.
 */
@Injectable()
export class VisibleMeetingGuard implements CanActivate {
  constructor(private readonly queryBus: QueryBus) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const meetingId: unknown = request.params['id'];
    const { user } = request as AuthenticatedRequest;

    // `user` is set by `JwtAuthGuard`, which the controller declares and which therefore
    // runs first; without it there is no caller to resolve visibility for.
    if (user === undefined || typeof meetingId !== 'string' || !UUID_PATTERN.test(meetingId)) {
      return true;
    }

    await requireVisibleMeeting(this.queryBus, user.id, meetingId);

    return true;
  }
}
