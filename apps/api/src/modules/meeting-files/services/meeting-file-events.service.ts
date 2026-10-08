import { BeforeApplicationShutdown, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventBus } from '@nestjs/cqrs';
import type { MeetingDigest, MeetingFile } from '@repo/shared';
import { Observable, ReplaySubject, Subject, interval, merge, timer } from 'rxjs';
import type { Subscription } from 'rxjs';
import { map, startWith, takeUntil } from 'rxjs/operators';

import { MeetingDigestChangedEvent } from '../../meeting-digests/events/meeting-digest-changed.event';
import { MeetingFileChangedEvent } from '../events/meeting-file-changed.event';
import { AnnouncedDeletes } from './announced-deletes';

/** The `event:` name every file change is sent under. A client filters on it. */
export const FILE_EVENT = 'file';

/**
 * The `event:` name the meeting's digest is sent under, on the same stream: a second stream
 * would double every meeting page's long-lived connections against a browser's six per
 * origin. A client that does not know the name ignores it, as it does a heartbeat.
 */
export const DIGEST_EVENT = 'digest';

/**
 * The `event:` name of a heartbeat. It carries no `data:`, which makes it a no-op for a
 * browser's `EventSource` — an event whose data buffer is empty is never dispatched — while
 * still being bytes on the wire, which is all a proxy's idle timer looks at.
 *
 * A `: ping` comment would be the idiomatic spelling, and it is what the phase plan asks for,
 * but Nest's `@Sse` writer can only produce `event:`/`id:`/`retry:`/`data:` lines from a
 * `MessageEvent`. Emitting a comment would mean writing to the response by hand and giving up
 * the guard, the pipe, and the filter that come with being an ordinary route. A named event
 * with no data buys the same thing at the cost of one line in the client's parser.
 */
export const PING_EVENT = 'ping';

/** How often the stream says something when the meeting has nothing to say. */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * One `Subject` per meeting that somebody is watching, fed by the module's `EventBus`.
 *
 * **Fan-out is in-process, and that is the PRD's F10 fixing a single API instance.** The
 * worker, the upload handler, and the delete handler publish on the bus this service
 * subscribes to; a second replica would have its own bus and its own subscribers, so a change
 * made on replica A would never reach a stream held open by replica B. The change to make if
 * a second replica ever appears is PostgreSQL `LISTEN/NOTIFY` in place of this subscription —
 * nothing above it moves.
 *
 * A meeting's subject exists only while someone is watching it: `stream()` creates it on
 * subscribe and drops it when the last subscriber leaves, so a process that has served a
 * thousand meetings holds as many subjects as it has open streams, which is none at rest.
 */
@Injectable()
export class MeetingFileEventsService implements OnModuleInit, BeforeApplicationShutdown {
  private readonly logger = new Logger(MeetingFileEventsService.name);
  private readonly meetings = new Map<string, Subject<MessageEvent>>();
  /** What makes `deleted` the last thing a stream says about a file. See the class. */
  private readonly deleted = new AnnouncedDeletes();
  /**
   * Emits once on shutdown; every open stream takes until it. **Replayed, so a stream opened
   * afterwards ends at once.** A client reopens its stream a second after it ended, and a
   * kept-alive socket still carries that request to the process that is closing. With a plain
   * `Subject` that stream missed the one emission and ran to the TTL: it kept the closing
   * server alive for five minutes and showed its page nothing, because the bus subscription
   * had already gone — while the process that replaced this one did the work.
   */
  private readonly closed = new ReplaySubject<void>(1);
  private subscription: Subscription | undefined;

  constructor(
    private readonly config: ConfigService,
    private readonly events: EventBus,
  ) {}

  /**
   * One subscription for the whole process, not one per stream: the bus carries every
   * module's events, and a filter per open connection would re-run the same `instanceof` for
   * each of them.
   *
   * **Two events are forwarded, and only a file's is checked against the deletes.** The
   * digest's is `MeetingDigestChangedEvent`, the one thing this module knows of the digest:
   * it carries a version, so an older one that arrives late is the subscriber's to drop,
   * and nothing here has to order it.
   */
  onModuleInit(): void {
    this.subscription = this.events.subscribe((event) => {
      if (event instanceof MeetingDigestChangedEvent) {
        this.send(event.meetingId, digestMessage(event.digest));
      } else if (event instanceof MeetingFileChangedEvent && this.deleted.admits(event.file)) {
        // Asked whether or not anyone is watching, so a delete is always remembered: the
        // late event it guards against may find a page that opened in between.
        this.send(event.meetingId, fileMessage(event.file));
      }
    });
  }

  /**
   * No subject means nobody is watching this meeting. Dropping the event here is the whole
   * reason a missed one has to be harmless: the client's next fetch is the repair.
   */
  private send(meetingId: string, message: MessageEvent): void {
    this.meetings.get(meetingId)?.next(message);
  }

  /**
   * Ends every open stream, and **`beforeApplicationShutdown` rather than
   * `onApplicationShutdown` because of the order Nest closes things in**: the HTTP server is
   * closed between those two hooks, and `server.close()` waits for every connection that is
   * still in flight. A stream ended in the later hook is therefore ended after the close it
   * is blocking — the process hangs on SIGTERM, and `app.close()` never resolves in a test.
   * This hook runs first, the responses end, and the sockets are idle by the time the server
   * is asked to close.
   */
  beforeApplicationShutdown(): void {
    this.subscription?.unsubscribe();
    // Completing the subjects is not enough on its own: a stream is a `merge` of its
    // meeting's subject and a heartbeat that never ends, and a merge ends only when every
    // source has. This is what actually closes the response.
    this.closed.next();

    for (const subject of this.meetings.values()) {
      subject.complete();
    }

    this.meetings.clear();
  }

  /**
   * The changes to one meeting's files, merged with the heartbeat, until the TTL.
   *
   * **The first heartbeat is immediate**, so "the stream is open" is something the client is
   * told rather than something it infers from silence. Nest defers the response headers
   * until the first message — so that an observable which errors straight away can still be
   * turned into a status code by the exception filter — and commits them itself one
   * macrotask later if nothing was emitted; the opening ping means a reader sees the same
   * thing whether or not that fallback fires.
   *
   * **It completes after `MEETING_FILES_STREAM_TTL_SECONDS` rather than running for ever.** A
   * tab left open overnight then reconnects — and a reconnect refetches the list, which is
   * the one thing that repairs a stream that silently stopped carrying events.
   */
  stream(meetingId: string): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      const subject = this.subjectFor(meetingId);
      const inner = merge(subject, heartbeat())
        .pipe(takeUntil(merge(timer(this.ttlMs()), this.closed)))
        .subscribe(subscriber);

      return () => {
        inner.unsubscribe();
        this.release(meetingId, subject);
      };
    });
  }

  /**
   * Read per stream rather than once in the constructor. `ConfigService` answers with the
   * validated boot-time value either way — changing the TTL is a restart, like every setting
   * here — but asking at subscribe is what lets the e2e suite shorten it with
   * `ConfigService.set` between tests instead of rebuilding the application, the same reason
   * the transcription worker asks for its setting on every tick.
   */
  private ttlMs(): number {
    return this.config.get<number>('MEETING_FILES_STREAM_TTL_SECONDS', 300) * 1_000;
  }

  private subjectFor(meetingId: string): Subject<MessageEvent> {
    const existing = this.meetings.get(meetingId);

    if (existing !== undefined) {
      return existing;
    }

    const created = new Subject<MessageEvent>();
    this.meetings.set(meetingId, created);
    this.logger.debug(`Watching meeting ${meetingId} (${String(this.meetings.size)} open)`);

    return created;
  }

  /** Drops a subject the moment its last subscriber leaves; a second tab keeps it alive. */
  private release(meetingId: string, subject: Subject<MessageEvent>): void {
    if (subject.observed) {
      return;
    }

    subject.complete();

    // Only if it is still the one this stream held: a subject dropped and recreated between
    // two ticks must not be removed by the departing stream of the one before it.
    if (this.meetings.get(meetingId) === subject) {
      this.meetings.delete(meetingId);
    }
  }
}

/**
 * `id` is the instant the event was sent rather than a sequence number, because there is
 * nothing to resume from: the client reconnects by refetching the list, not by replaying from
 * a `Last-Event-ID`. It is there so a stream is readable in `curl -N`.
 */
function fileMessage(file: MeetingFile): MessageEvent {
  return { type: FILE_EVENT, id: new Date().toISOString(), data: file };
}

/** The digest as `GET …/digest` answers it; `id` as for a file. Its order is its `version`. */
function digestMessage(digest: MeetingDigest): MessageEvent {
  return { type: DIGEST_EVENT, id: new Date().toISOString(), data: digest };
}

/**
 * `startWith` rather than `timer(0, …)`, so the opening beat is emitted during `subscribe`
 * rather than a macrotask later: the stream's first bytes then do not depend on how the
 * runtime happens to order the response's own header write against a zero-delay timer.
 */
function heartbeat(): Observable<MessageEvent> {
  return interval(HEARTBEAT_INTERVAL_MS).pipe(
    startWith(0),
    map(() => ({ type: PING_EVENT, id: new Date().toISOString(), data: '' })),
  );
}
