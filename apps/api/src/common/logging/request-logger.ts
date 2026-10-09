import { HttpStatus, Logger } from '@nestjs/common';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** What `createRequestLogger` writes with: the two levels of a `Logger`, so a spec can watch. */
export type RequestLog = Pick<Logger, 'log' | 'warn'>;

/** Longer than any route here; past it a request target is somebody filling the log. */
const MAX_LOGGED_URL_LENGTH = 2_048;

/** Everything that is not a visible ASCII character: controls, spaces, and bytes above them. */
const UNPRINTABLE = /[^\x21-\x7e]/g;

/**
 * Logs method, path, status, and duration once per request, when its response is over.
 *
 * **Middleware, and it must not become an interceptor again.** An interceptor sees only what
 * reached a handler, as often as the handler answers. So a request a guard refused — a bad
 * token, a spent rate limit — and a path no route matches left no line at all, while a files
 * stream left one for every event and every heartbeat it sent, each with a longer duration
 * than the last. Here a request is one line whoever answered it, a stream included.
 *
 * The line is written at `close`, the one event every response ends with: sent in full, or
 * cut short because the client went away. A refusal is a warning, so the requests somebody
 * was told no to can be read without the ones that worked.
 */
export function createRequestLogger(logger: RequestLog = new Logger('HTTP')): RequestHandler {
  return (request: Request, response: Response, next: NextFunction): void => {
    const startedAt = Date.now();

    response.once('close', () => {
      const line = `${request.method} ${printable(request.originalUrl)} ${outcomeOf(response)} ${String(Date.now() - startedAt)}ms`;

      if (response.writableFinished && response.statusCode >= HttpStatus.BAD_REQUEST) {
        logger.warn(line);
      } else {
        logger.log(line);
      }
    });

    next();
  };
}

/**
 * The request target as it is safe to write to a log. Whoever sends a request chooses it, and
 * this line is written for callers no guard has let in: visible ASCII only, so nothing in it
 * can drive a terminal an operator reads the log in, and no longer than a line.
 */
function printable(url: string): string {
  const visible = url.replace(UNPRINTABLE, '?');

  return visible.length > MAX_LOGGED_URL_LENGTH
    ? `${visible.slice(0, MAX_LOGGED_URL_LENGTH)}…`
    : visible;
}

/**
 * The status, and whether it is the whole story. A connection that closed before the response
 * finished is said so rather than logged as the status it would have had: for a stream that
 * is how every page that navigates away ends one, and for anything else it is a client that
 * did not wait for its answer.
 */
function outcomeOf(response: Response): string {
  if (response.writableFinished) {
    return String(response.statusCode);
  }

  return response.headersSent
    ? `${String(response.statusCode)} (closed by the client)`
    : 'unanswered (closed by the client)';
}
