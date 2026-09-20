import type { MessageEvent } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventBus } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';
import type { MeetingFile } from '@repo/shared';
import { Subject } from 'rxjs';

import { MeetingFileChangedEvent } from '../events/meeting-file-changed.event';
import {
  FILE_EVENT,
  HEARTBEAT_INTERVAL_MS,
  MeetingFileEventsService,
  PING_EVENT,
} from './meeting-file-events.service';

const MEETING_A = '44444444-4444-4444-8444-444444444444';
const MEETING_B = '77777777-7777-4777-8777-777777777777';
const FILE_ID = '55555555-5555-4555-8555-555555555555';

const file = (meetingId: string, overrides: Partial<MeetingFile> = {}): MeetingFile => ({
  id: FILE_ID,
  meetingId,
  uploaderId: '11111111-1111-4111-8111-111111111111',
  name: 'deck.pdf',
  contentType: 'application/pdf',
  size: 10,
  status: 'ready',
  createdAt: '2026-09-01T10:00:00.000Z',
  ...overrides,
});

/** What a subscriber saw, and whether the stream has ended. */
interface Watcher {
  events: MessageEvent[];
  completed: boolean;
  stop(): void;
}

/** The `MeetingFile`s a watcher was sent, heartbeats aside. */
const filesOf = (watcher: Watcher): MeetingFile[] =>
  watcher.events
    .filter((event) => event.type === FILE_EVENT)
    .map((event) => event.data as MeetingFile);

describe('MeetingFileEventsService', () => {
  /** Stands in for the module's `EventBus`, which is an `Observable` of every event. */
  let bus: Subject<unknown>;
  let service: MeetingFileEventsService;

  const build = async (ttlSeconds = 300): Promise<MeetingFileEventsService> => {
    bus = new Subject<unknown>();
    const moduleRef = await Test.createTestingModule({
      providers: [
        MeetingFileEventsService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, fallback: unknown) =>
              key === 'MEETING_FILES_STREAM_TTL_SECONDS' ? ttlSeconds : fallback,
          },
        },
        { provide: EventBus, useValue: bus },
      ],
    }).compile();

    const built = moduleRef.get(MeetingFileEventsService);
    built.onModuleInit();

    return built;
  };

  const watch = (meetingId: string): Watcher => {
    const watcher: Watcher = { events: [], completed: false, stop: () => {} };
    const subscription = service.stream(meetingId).subscribe({
      next: (event) => watcher.events.push(event),
      complete: () => {
        watcher.completed = true;
      },
    });
    watcher.stop = () => subscription.unsubscribe();

    return watcher;
  };

  beforeEach(async () => {
    jest.useFakeTimers();
    service = await build();
  });

  afterEach(() => {
    service.onApplicationShutdown();
    jest.useRealTimers();
  });

  it('opens with a heartbeat, so the response headers reach the client at once', () => {
    const watcher = watch(MEETING_A);

    // Nest holds the headers back until the first message; a client that must check
    // `content-type: text/event-stream` would otherwise wait for the meeting to change.
    expect(watcher.events).toEqual([{ type: PING_EVENT, id: expect.any(String), data: '' }]);
  });

  it('beats every 15 seconds while nothing happens', () => {
    const watcher = watch(MEETING_A);

    jest.advanceTimersByTime(HEARTBEAT_INTERVAL_MS - 1);
    expect(watcher.events).toHaveLength(1);

    jest.advanceTimersByTime(1);
    expect(watcher.events).toHaveLength(2);

    jest.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 2);
    expect(watcher.events).toHaveLength(4);
    expect(watcher.events.every(({ type }) => type === PING_EVENT)).toBe(true);
  });

  it('sends a change as one `file` event carrying the whole MeetingFile', () => {
    const watcher = watch(MEETING_A);
    const changed = file(MEETING_A, { status: 'processing' });

    bus.next(new MeetingFileChangedEvent(MEETING_A, changed));

    expect(watcher.events[1]).toEqual({
      type: FILE_EVENT,
      // An instant, not a sequence number: there is nothing to resume from, and a stream
      // read with `curl -N` is the better use of the field.
      id: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      data: changed,
    });
  });

  it('keeps meetings apart: a change to one is not sent to a stream on the other', () => {
    const a = watch(MEETING_A);
    const b = watch(MEETING_B);

    bus.next(new MeetingFileChangedEvent(MEETING_A, file(MEETING_A)));

    expect(filesOf(a)).toHaveLength(1);
    expect(filesOf(b)).toHaveLength(0);
  });

  it('sends one meeting`s change to every stream watching it', () => {
    const first = watch(MEETING_A);
    const second = watch(MEETING_A);

    bus.next(new MeetingFileChangedEvent(MEETING_A, file(MEETING_A)));

    expect(filesOf(first)).toHaveLength(1);
    expect(filesOf(second)).toHaveLength(1);
  });

  it('ignores anything on the bus that is not a file change', () => {
    const watcher = watch(MEETING_A);

    bus.next({ meetingId: MEETING_A, file: file(MEETING_A) });
    bus.next('a string');

    // The bus carries every module's events; only this one's shape may reach a stream.
    expect(filesOf(watcher)).toHaveLength(0);
  });

  it('completes the stream after the TTL', async () => {
    service.onApplicationShutdown();
    service = await build(2);
    const watcher = watch(MEETING_A);

    jest.advanceTimersByTime(1_999);
    expect(watcher.completed).toBe(false);

    jest.advanceTimersByTime(1);
    expect(watcher.completed).toBe(true);

    // And nothing reaches it afterwards: a tab left open reconnects rather than being fed
    // by a connection nobody is accounting for.
    bus.next(new MeetingFileChangedEvent(MEETING_A, file(MEETING_A)));
    expect(filesOf(watcher)).toHaveLength(0);
  });

  it('drops a meeting`s subject once the last stream leaves, and builds a new one after', () => {
    const first = watch(MEETING_A);
    const second = watch(MEETING_A);

    first.stop();
    expect(subjects()).toEqual([MEETING_A]);

    second.stop();
    expect(subjects()).toEqual([]);

    // A watcher that arrives later gets a working stream, not the corpse of the old subject.
    const third = watch(MEETING_A);
    bus.next(new MeetingFileChangedEvent(MEETING_A, file(MEETING_A)));

    expect(filesOf(third)).toHaveLength(1);
  });

  it('completes every open stream on shutdown, so no handle outlives the process', () => {
    const watcher = watch(MEETING_A);

    service.onApplicationShutdown();

    expect(watcher.completed).toBe(true);
    expect(subjects()).toEqual([]);

    // The bus subscription is gone too: a later event reaches nothing.
    bus.next(new MeetingFileChangedEvent(MEETING_A, file(MEETING_A)));
    expect(filesOf(watcher)).toHaveLength(0);
  });

  /** The meeting ids the service is holding a subject for. */
  const subjects = (): string[] => [
    ...(service as unknown as { meetings: Map<string, unknown> }).meetings.keys(),
  ];
});
