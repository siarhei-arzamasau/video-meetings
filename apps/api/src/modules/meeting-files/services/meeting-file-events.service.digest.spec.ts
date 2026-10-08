import type { MessageEvent } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventBus } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';
import type { MeetingDigest, MeetingFile } from '@repo/shared';
import { Subject } from 'rxjs';

import { MeetingDigestChangedEvent } from '../../meeting-digests/events/meeting-digest-changed.event';
import { MeetingFileChangedEvent } from '../events/meeting-file-changed.event';
import {
  DIGEST_EVENT,
  FILE_EVENT,
  MeetingFileEventsService,
  PING_EVENT,
} from './meeting-file-events.service';

const MEETING_A = '44444444-4444-4444-8444-444444444444';
const MEETING_B = '77777777-7777-4777-8777-777777777777';

const digest = (meetingId: string, overrides: Partial<MeetingDigest> = {}): MeetingDigest => ({
  meetingId,
  version: 3,
  status: 'ready',
  content: {
    summary: 'The team agreed to ship on Friday.',
    actionItems: [{ id: 'item-1', description: 'Send the release notes.' }],
    decisions: [{ id: 'decision-1', description: 'Ship on Friday.' }],
    generatedAt: '2026-10-08T09:00:00.000Z',
    outOfDate: false,
  },
  ...overrides,
});

const RECORDING: MeetingFile = {
  id: '55555555-5555-4555-8555-555555555555',
  meetingId: MEETING_A,
  uploaderId: '11111111-1111-4111-8111-111111111111',
  name: 'standup.mp3',
  contentType: 'audio/mpeg',
  size: 10,
  status: 'ready',
  createdAt: '2026-09-01T10:00:00.000Z',
};

/**
 * The digest on the files stream: a second event name beside `file`, forwarded as it is
 * published. The stream itself — heartbeat, TTL, shutdown — is the spec beside this one's.
 */
describe('MeetingFileEventsService: the digest event', () => {
  /** Stands in for the module's `EventBus`, which is an `Observable` of every event. */
  let bus: Subject<unknown>;
  let service: MeetingFileEventsService;

  /** What one meeting's stream sent, heartbeats aside. */
  const watch = (meetingId: string): MessageEvent[] => {
    const events: MessageEvent[] = [];

    service.stream(meetingId).subscribe((event) => {
      if (event.type !== PING_EVENT) {
        events.push(event);
      }
    });

    return events;
  };

  beforeEach(async () => {
    jest.useFakeTimers();
    bus = new Subject<unknown>();

    const moduleRef = await Test.createTestingModule({
      providers: [
        MeetingFileEventsService,
        {
          provide: ConfigService,
          useValue: { get: (_key: string, fallback: unknown) => fallback },
        },
        { provide: EventBus, useValue: bus },
      ],
    }).compile();

    service = moduleRef.get(MeetingFileEventsService);
    service.onModuleInit();
  });

  afterEach(() => {
    service.beforeApplicationShutdown();
    jest.useRealTimers();
  });

  it('sends a changed digest as one `digest` event carrying the whole MeetingDigest', () => {
    const events = watch(MEETING_A);
    const changed = digest(MEETING_A);

    bus.next(new MeetingDigestChangedEvent(MEETING_A, changed));

    expect(DIGEST_EVENT).toBe('digest');
    expect(events).toEqual([
      { type: DIGEST_EVENT, id: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/), data: changed },
    ]);
  });

  it('sends a digest only to the streams of its own meeting, every one of them', () => {
    const first = watch(MEETING_A);
    const second = watch(MEETING_A);
    const other = watch(MEETING_B);

    bus.next(new MeetingDigestChangedEvent(MEETING_A, digest(MEETING_A)));

    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
    expect(other).toEqual([]);
  });

  it('sends a meeting that lost its digest: no status and no content is still an event', () => {
    const events = watch(MEETING_A);
    const gone: MeetingDigest = { meetingId: MEETING_A, version: 9 };

    bus.next(new MeetingDigestChangedEvent(MEETING_A, gone));

    expect(events.map(({ data }) => data)).toEqual([gone]);
  });

  it('sends files and digests on the one stream, in the order they were published', () => {
    const events = watch(MEETING_A);

    bus.next(new MeetingFileChangedEvent(MEETING_A, RECORDING));
    bus.next(new MeetingDigestChangedEvent(MEETING_A, digest(MEETING_A, { status: 'queued' })));
    bus.next(new MeetingFileChangedEvent(MEETING_A, { ...RECORDING, status: 'deleted' }));
    bus.next(new MeetingDigestChangedEvent(MEETING_A, { meetingId: MEETING_A, version: 4 }));

    expect(events.map(({ type }) => type)).toEqual([
      FILE_EVENT,
      DIGEST_EVENT,
      FILE_EVENT,
      DIGEST_EVENT,
    ]);
  });

  it('forwards digests as published, an older version after a newer included: the version orders them', () => {
    const events = watch(MEETING_A);

    bus.next(new MeetingDigestChangedEvent(MEETING_A, digest(MEETING_A, { version: 6 })));
    bus.next(new MeetingDigestChangedEvent(MEETING_A, digest(MEETING_A, { version: 5 })));

    // Nothing here drops the late one, as a file's late event is dropped after its delete:
    // a subscriber that keeps the higher version needs nothing dropped for it.
    expect(events.map(({ data }) => (data as MeetingDigest).version)).toEqual([6, 5]);
  });

  it('drops a digest for a meeting nobody is watching, and sends nothing once the stream has closed', () => {
    bus.next(new MeetingDigestChangedEvent(MEETING_A, digest(MEETING_A)));
    const events = watch(MEETING_A);
    expect(events).toEqual([]);

    service.beforeApplicationShutdown();
    bus.next(new MeetingDigestChangedEvent(MEETING_A, digest(MEETING_A)));
    expect(events).toEqual([]);
  });

  it('ignores whatever else is on the bus', () => {
    const events = watch(MEETING_A);

    bus.next({ meetingId: MEETING_A, digest: digest(MEETING_A) });

    expect(events).toEqual([]);
  });
});
