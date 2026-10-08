import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

import { Injectable, OnModuleDestroy } from '@nestjs/common';

/**
 * Lets go of kept-alive connections once shutdown has begun, so a stopping process stops
 * being reachable.
 *
 * Node closes idle connections once, at the moment `server.close()` is called. A connection
 * that is busy then — a files stream is, on every open meeting page — goes back to being
 * kept alive when its response ends, and nothing closes it after that except five seconds of
 * silence. A page does not give it five seconds: it reopens its stream after one and polls
 * every three, each request on that same socket. Measured on a stopped API with one page
 * open: the process answered that page for 96 seconds after SIGTERM, with its workers gone
 * and its database connection already closed, while the process that replaced it did the work.
 *
 * So from the first shutdown hook on, a connection is closed as soon as it has nothing left
 * to answer:
 *
 * - a response that has not started — for a request that arrives now, or one still being
 *   handled — goes out in full with `Connection: close`, and Node closes the socket behind it;
 * - a response already under way, whose headers promised to keep the connection — a stream, a
 *   download — is sent in full too, and the socket is closed when it ends. Its client was not
 *   told, so one that sends its next request in that same instant sees a reset on a reused
 *   connection, exactly as it does when a keep-alive timeout wins that race; browsers send
 *   it again on a new one.
 *
 * **Nothing in flight is cut off**, which is why this is not Nest's `forceCloseConnections`:
 * that destroys every socket, and a chunk of a gigabyte upload with it. An idle connection is
 * left to Node, which closes those itself when the server is closed a moment later.
 */
@Injectable()
export class ConnectionDrainService implements OnModuleDestroy {
  private draining = false;
  /** Every response not yet finished, with the connection it will go out on. */
  private readonly unanswered = new Map<ServerResponse, Socket>();

  /**
   * Registered before everything else in `configureApp`, so no answer leaves without passing
   * it. An arrow property: Express calls a middleware unbound.
   */
  readonly middleware = (
    request: IncomingMessage,
    response: ServerResponse,
    next: () => void,
  ): void => {
    // The request's socket, kept here: a pipelined response has none of its own until the
    // one ahead of it has gone out.
    this.unanswered.set(response, request.socket);
    // `close`, not `finish`: it follows the last byte being handed over, and it is also what
    // a response gets when its connection is lost before then.
    response.once('close', () => this.answered(response));

    if (this.draining) {
      response.setHeader('Connection', 'close');
    }

    next();
  };

  /**
   * `onModuleDestroy` because it is the first hook Nest runs, and this is the root module's
   * provider, so it runs before any other module's: the HTTP server is not asked to close
   * until every destroy and before-shutdown hook has finished, and requests keep arriving
   * the whole time.
   */
  onModuleDestroy(): void {
    this.draining = true;

    for (const response of this.unanswered.keys()) {
      // Still being handled: there is time to tell its client not to come back this way.
      if (!response.headersSent) {
        response.setHeader('Connection', 'close');
      }
    }
  }

  private answered(response: ServerResponse): void {
    const socket = this.unanswered.get(response);

    this.unanswered.delete(response);

    if (!this.draining || socket === undefined) {
      return;
    }

    // A pipelined request on the same connection is still owed its answer.
    if (![...this.unanswered.values()].includes(socket)) {
      // After what is still buffered has been written, never before.
      socket.destroySoon();
    }
  }
}
