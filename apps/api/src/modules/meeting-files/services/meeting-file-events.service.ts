import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventBus } from '@nestjs/cqrs';
import type { MeetingFile } from '@repo/shared';
import { Observable, Subject, interval, merge, timer } from 'rxjs';
import type { Subscription } from 'rxjs';
import { filter, map, startWith, takeUntil } from 'rxjs/operators';

import { MeetingFileChangedEvent } from '../events/meeting-file-changed.event';

/** The `event:` name every file change is sent under. A client filters on it. */
export const FILE_EVENT = 'file';

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
export class MeetingFileEventsService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(MeetingFileEventsService.name);
  private readonly ttlMs: number;
  private readonly meetings = new Map<string, Subject<MessageEvent>>();
  /** Emits once on shutdown; every open stream takes until it. */
  private readonly closed = new Subject<void>();
  private subscription: Subscription | undefined;

  constructor(
    config: ConfigService,
    private readonly events: EventBus,
  ) {
    this.ttlMs = config.get<number>('MEETING_FILES_STREAM_TTL_SECONDS', 300) * 1_000;
  }

  /**
   * One subscription for the whole process, not one per stream: the bus carries every
   * module's events, and a filter per open connection would re-run the same `instanceof` for
   * each of them.
   */
  onModuleInit(): void {
    this.subscription = this.events
      .pipe(
        filter(
          (event): event is MeetingFileChangedEvent => event instanceof MeetingFileChangedEvent,
        ),
      )
      .subscribe((event) => {
        // No subject means nobody is watching this meeting. Dropping the event here is the
        // whole reason a missed one has to be harmless: the client's next list is the repair.
        this.meetings.get(event.meetingId)?.next(fileMessage(event.file));
      });
  }

  /**
   * Ends every open stream before the process goes, so a connection held open is not a
   * handle that keeps Node — or Jest — alive past the last test.
   */
  onApplicationShutdown(): void {
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
        .pipe(takeUntil(merge(timer(this.ttlMs), this.closed)))
        .subscribe(subscriber);

      return () => {
        inner.unsubscribe();
        this.release(meetingId, subject);
      };
    });
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
