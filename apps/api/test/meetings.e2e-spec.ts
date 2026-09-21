import { randomUUID } from 'node:crypto';

import type { Meeting } from '@repo/shared';
import type request from 'supertest';

import { useApiSuite } from './utils/api-suite';
import {
  EMAIL,
  MAX_MEETINGS_LIMIT,
  MAX_PARTICIPANTS,
  MAX_TITLE_LENGTH,
  MEETINGS_URL,
  OTHER_EMAIL,
  PASSWORD,
  REGISTER_URL,
  TEST_JWT_SECRET,
  THIRD_EMAIL,
} from './utils/fixtures';
import { accessTokenOf } from './utils/http';
import { signJwtHmac } from './utils/jwt';
import {
  countMeetings,
  countParticipants,
  findMeetingRows,
  findParticipantIds,
} from './utils/meetings-table';
import { findUserRow } from './utils/users-table';

interface RegisteredUser {
  id: string;
  token: string;
}

describe('Meetings API', () => {
  const suite = useApiSuite();

  const registerUser = async (email: string): Promise<RegisteredUser> => {
    const response = await suite.post(REGISTER_URL, { email, password: PASSWORD }).expect(201);
    const user = await findUserRow(suite.prisma(), email);

    return { id: user.id, token: accessTokenOf(response) };
  };

  const createMeeting = (token: string, body: object) =>
    suite.post(MEETINGS_URL, body).set('Authorization', `Bearer ${token}`);

  const listMeetings = (token: string, query = '') =>
    suite.get(`${MEETINGS_URL}${query}`).set('Authorization', `Bearer ${token}`);

  const fetchMeetingCount = (token: string) =>
    suite.get(`${MEETINGS_URL}/count`).set('Authorization', `Bearer ${token}`);

  const getMeeting = (token: string, meetingId: string) =>
    suite.get(`${MEETINGS_URL}/${meetingId}`).set('Authorization', `Bearer ${token}`);

  describe(`POST ${MEETINGS_URL}`, () => {
    it('creates a scheduled meeting owned by the current user', async () => {
      const host = await registerUser(EMAIL);
      const grace = await registerUser(OTHER_EMAIL);
      const charles = await registerUser(THIRD_EMAIL);
      const scheduledAt = futureInstant();

      const response = await createMeeting(host.token, {
        title: 'Analytical Engine planning',
        scheduledAt,
        participantIds: [grace.id, charles.id],
      }).expect(201);
      const body = response.body as Meeting;

      expect(Object.keys(body).toSorted()).toEqual([
        'hostId',
        'id',
        'participantIds',
        'scheduledAt',
        'status',
        'title',
      ]);
      expect(body).toEqual({
        id: expect.any(String),
        title: 'Analytical Engine planning',
        status: 'scheduled',
        hostId: host.id,
        scheduledAt,
        participantIds: [grace.id, charles.id].toSorted(),
      });
    });

    it('stores exactly the meeting it reported, and does not store the host as a participant', async () => {
      const host = await registerUser(EMAIL);
      const grace = await registerUser(OTHER_EMAIL);
      const scheduledAt = futureInstant();

      const response = await createMeeting(host.token, {
        title: 'Engine review',
        scheduledAt,
        participantIds: [grace.id],
      }).expect(201);
      const body = response.body as Meeting;

      // Read the rows directly rather than through the API: a response is not evidence about
      // what was written, and the host silently landing in `meeting_participants` would be
      // invisible to any assertion that goes back through the same `include`.
      const rows = await findMeetingRows(suite.prisma());

      expect(rows).toEqual([
        {
          id: body.id,
          title: 'Engine review',
          status: 'scheduled',
          host_id: host.id,
          scheduled_at: new Date(scheduledAt),
        },
      ]);
      await expect(findParticipantIds(suite.prisma(), body.id)).resolves.toEqual([grace.id]);
    });

    it('allows a meeting with no participants', async () => {
      const host = await registerUser(EMAIL);

      const response = await createMeeting(host.token, {
        title: 'Private planning',
        scheduledAt: futureInstant(),
        participantIds: [],
      }).expect(201);
      const body = response.body as Meeting;

      expect(body.participantIds).toEqual([]);
      await expect(countParticipants(suite.prisma())).resolves.toBe(0);
    });

    it.each([
      ['a missing title', ({ scheduledAt }: Body) => ({ scheduledAt, participantIds: [] })],
      [
        'a blank title',
        ({ scheduledAt }: Body) => ({ title: '   ', scheduledAt, participantIds: [] }),
      ],
      [
        'an over-long title',
        ({ scheduledAt }: Body) => ({
          title: 'a'.repeat(MAX_TITLE_LENGTH + 1),
          scheduledAt,
          participantIds: [],
        }),
      ],
      ['a missing timestamp', () => ({ title: 'Planning', participantIds: [] })],
      [
        'an unparseable timestamp',
        () => ({ title: 'Planning', scheduledAt: 'tomorrow afternoon', participantIds: [] }),
      ],
      [
        // Would parse to midnight UTC, so the response could not echo what was sent.
        'a bare calendar date',
        () => ({ title: 'Planning', scheduledAt: '2026-08-01', participantIds: [] }),
      ],
      [
        'an impossible calendar date',
        () => ({ title: 'Planning', scheduledAt: '2026-02-31T10:00:00.000Z', participantIds: [] }),
      ],
      ['missing participants', ({ scheduledAt }: Body) => ({ title: 'Planning', scheduledAt })],
      [
        'a non-array participants value',
        ({ scheduledAt }: Body) => ({
          title: 'Planning',
          scheduledAt,
          participantIds: 'user-id',
        }),
      ],
      [
        'a non-string participant id',
        ({ scheduledAt }: Body) => ({ title: 'Planning', scheduledAt, participantIds: [123] }),
      ],
      [
        'a participant id that is not a uuid',
        ({ scheduledAt }: Body) => ({
          title: 'Planning',
          scheduledAt,
          participantIds: ['not-a-uuid'],
        }),
      ],
      [
        'more participants than the ceiling allows',
        ({ scheduledAt }: Body) => ({
          title: 'Planning',
          scheduledAt,
          participantIds: Array.from({ length: MAX_PARTICIPANTS + 1 }, () => randomUUID()),
        }),
      ],
      [
        'an unrecognised field',
        ({ scheduledAt }: Body) => ({
          title: 'Planning',
          scheduledAt,
          participantIds: [],
          hostId: randomUUID(),
        }),
      ],
    ])('rejects %s with 400', async (_description, bodyFor) => {
      const host = await registerUser(EMAIL);

      await createMeeting(host.token, bodyFor({ scheduledAt: futureInstant() })).expect(400);
      await expect(countMeetings(suite.prisma())).resolves.toBe(0);
    });

    it('rejects the same participant twice with different UUID casing', async () => {
      const host = await registerUser(EMAIL);
      const participant = await registerUser(OTHER_EMAIL);

      await createMeeting(host.token, {
        title: 'Duplicate participant',
        scheduledAt: futureInstant(),
        participantIds: [participant.id, participant.id.toUpperCase()],
      }).expect(400);

      await expect(countMeetings(suite.prisma())).resolves.toBe(0);
    });

    it('rejects the host listing themselves as a participant', async () => {
      const host = await registerUser(EMAIL);

      // Hosting and attending are distinct roles: `hostId` already names them.
      await createMeeting(host.token, {
        title: 'Self-invite',
        scheduledAt: futureInstant(),
        participantIds: [host.id],
      }).expect(400);

      await expect(countMeetings(suite.prisma())).resolves.toBe(0);
    });

    it('rejects an unknown participant without creating the meeting', async () => {
      const host = await registerUser(EMAIL);

      await createMeeting(host.token, {
        title: 'Unknown participant',
        scheduledAt: futureInstant(),
        participantIds: [randomUUID()],
      }).expect(400);

      // Counted over the whole table, not just this host's list: a nested create that was
      // rolled back only partially would leave a meeting nobody can see.
      await expect(countMeetings(suite.prisma())).resolves.toBe(0);
      await expect(countParticipants(suite.prisma())).resolves.toBe(0);
    });
  });

  describe(`GET ${MEETINGS_URL}`, () => {
    it('returns an empty list when the current user has no meetings', async () => {
      const user = await registerUser(EMAIL);

      const response = await listMeetings(user.token).expect(200);

      expect(response.body).toEqual([]);
    });

    it('returns hosted and joined meetings but excludes unrelated meetings', async () => {
      const ada = await registerUser(EMAIL);
      const grace = await registerUser(OTHER_EMAIL);
      const charles = await registerUser(THIRD_EMAIL);

      const hosted = await createMeeting(ada.token, {
        title: 'Hosted by Ada',
        scheduledAt: futureInstant(1),
        participantIds: [grace.id],
      }).expect(201);
      const joined = await createMeeting(grace.token, {
        title: 'Hosted by Grace',
        scheduledAt: futureInstant(2),
        participantIds: [ada.id],
      }).expect(201);
      await createMeeting(charles.token, {
        title: 'Unrelated meeting',
        scheduledAt: futureInstant(3),
        participantIds: [],
      }).expect(201);

      const response = await listMeetings(ada.token).expect(200);

      expect(response.body).toEqual([hosted.body, joined.body]);
    });

    it('orders meetings sharing one instant by id, so the order is stable', async () => {
      const host = await registerUser(EMAIL);
      const scheduledAt = futureInstant();

      const first = await createMeeting(host.token, {
        title: 'Same instant A',
        scheduledAt,
        participantIds: [],
      }).expect(201);
      const second = await createMeeting(host.token, {
        title: 'Same instant B',
        scheduledAt,
        participantIds: [],
      }).expect(201);

      const response = await listMeetings(host.token).expect(200);
      const meetings = response.body as Meeting[];

      // Insertion order says nothing here — the tie-break is on id, so derive the expectation
      // from the ids rather than from which request happened to be sent first.
      expect(meetings).toEqual(
        [first.body as Meeting, second.body as Meeting].toSorted((a, b) => (a.id < b.id ? -1 : 1)),
      );
    });

    it('returns the latest first, as many as `limit` asks for', async () => {
      const host = await registerUser(EMAIL);
      const inDays = async (days: number): Promise<Meeting> => {
        const response = await createMeeting(host.token, {
          title: `In ${String(days)} days`,
          scheduledAt: futureInstant(days),
          participantIds: [],
        }).expect(201);

        return response.body as Meeting;
      };
      const soon = await inDays(1);
      const latest = await inDays(3);
      const later = await inDays(2);

      const limited = await listMeetings(host.token, '?order=desc&limit=2').expect(200);
      const everything = await listMeetings(host.token, '?order=desc').expect(200);

      expect(limited.body).toEqual([latest, later]);
      expect(everything.body).toEqual([latest, later, soon]);
    });

    it.each([
      ['a limit of zero', '?limit=0'],
      [`a limit over ${String(MAX_MEETINGS_LIMIT)}`, `?limit=${String(MAX_MEETINGS_LIMIT + 1)}`],
      ['a fractional limit', '?limit=1.5'],
      ['a limit that is not a number', '?limit=ten'],
      ['an order it does not know', '?order=newest'],
      ['a parameter it does not know', '?page=2'],
    ])('rejects %s with 400', async (_description, query) => {
      const user = await registerUser(EMAIL);

      await listMeetings(user.token, query).expect(400);
    });

    it(`accepts a limit of exactly ${String(MAX_MEETINGS_LIMIT)}`, async () => {
      const user = await registerUser(EMAIL);

      await listMeetings(user.token, `?limit=${String(MAX_MEETINGS_LIMIT)}`).expect(200);
    });
  });

  describe(`GET ${MEETINGS_URL}/count`, () => {
    it('counts hosted and joined meetings but not unrelated ones', async () => {
      const ada = await registerUser(EMAIL);
      const grace = await registerUser(OTHER_EMAIL);
      const charles = await registerUser(THIRD_EMAIL);
      await createMeeting(ada.token, {
        title: 'Hosted by Ada',
        scheduledAt: futureInstant(1),
        participantIds: [grace.id],
      }).expect(201);
      await createMeeting(grace.token, {
        title: 'Hosted by Grace',
        scheduledAt: futureInstant(2),
        participantIds: [ada.id],
      }).expect(201);
      await createMeeting(charles.token, {
        title: 'Unrelated meeting',
        scheduledAt: futureInstant(3),
        participantIds: [],
      }).expect(201);

      await expect(fetchMeetingCount(ada.token).expect(200)).resolves.toMatchObject({
        body: { total: 2 },
      });
      await expect(fetchMeetingCount(charles.token).expect(200)).resolves.toMatchObject({
        body: { total: 1 },
      });
    });

    it('is zero for someone with no meetings, not a 404', async () => {
      const user = await registerUser(EMAIL);

      const response = await fetchMeetingCount(user.token).expect(200);

      expect(response.body).toEqual({ total: 0 });
    });
  });

  describe(`GET ${MEETINGS_URL}/:id`, () => {
    it('returns the meeting to its host', async () => {
      const host = await registerUser(EMAIL);
      const participant = await registerUser(OTHER_EMAIL);
      const created = await createMeeting(host.token, {
        title: 'Engine review',
        scheduledAt: futureInstant(),
        participantIds: [participant.id],
      }).expect(201);
      const meeting = created.body as Meeting;

      const response = await getMeeting(host.token, meeting.id).expect(200);

      expect(response.body).toEqual(meeting);
    });

    it('returns the meeting to one of its participants', async () => {
      const host = await registerUser(EMAIL);
      const participant = await registerUser(OTHER_EMAIL);
      const created = await createMeeting(host.token, {
        title: 'Engine review',
        scheduledAt: futureInstant(),
        participantIds: [participant.id],
      }).expect(201);
      const meeting = created.body as Meeting;

      const response = await getMeeting(participant.token, meeting.id).expect(200);

      expect(response.body).toEqual(meeting);
    });

    it('returns 404 when the meeting does not exist', async () => {
      const user = await registerUser(EMAIL);
      await createMeeting(user.token, {
        title: 'Existing meeting',
        scheduledAt: futureInstant(),
        participantIds: [],
      }).expect(201);

      await getMeeting(user.token, randomUUID()).expect(404);
    });

    it('returns 404 when the meeting belongs to another user', async () => {
      const host = await registerUser(EMAIL);
      const otherUser = await registerUser(OTHER_EMAIL);
      const created = await createMeeting(host.token, {
        title: 'Host-only meeting',
        scheduledAt: futureInstant(),
        participantIds: [],
      }).expect(201);
      const meeting = created.body as Meeting;

      await getMeeting(otherUser.token, meeting.id).expect(404);
    });

    it.each([
      ['not a uuid at all', 'meeting-1'],
      // `id` is a uuid column: an unparseable value would make Postgres raise rather than
      // simply not match, so the pipe has to reject it before the query.
      ['a uuid of another version', '00000000-0000-1000-8000-000000000000'],
    ])('rejects %s with 400 rather than reaching the database', async (_description, id) => {
      const user = await registerUser(EMAIL);

      await getMeeting(user.token, id).expect(400);
    });
  });

  describe('authentication', () => {
    const expectEveryEndpointToReject = async (authorization?: string): Promise<void> => {
      // The invalid POST body and unknown meeting id prove the guard runs before request
      // validation and record lookup. Unauthenticated callers always receive 401.
      const expectRejected = async (httpRequest: request.Test): Promise<void> => {
        if (authorization !== undefined) {
          httpRequest.set('Authorization', authorization);
        }

        await httpRequest.expect(401);
      };

      await expectRejected(suite.post(MEETINGS_URL, {}));
      await expectRejected(suite.get(MEETINGS_URL));
      await expectRejected(suite.get(`${MEETINGS_URL}?limit=not-a-number`));
      await expectRejected(suite.get(`${MEETINGS_URL}/count`));
      await expectRejected(suite.get(`${MEETINGS_URL}/${randomUUID()}`));
    };

    it('rejects requests without credentials on every endpoint', async () => {
      await expectEveryEndpointToReject();
    });

    it.each([
      ['a malformed token', () => 'Bearer not-a-jwt'],
      [
        'a token signed with a different secret',
        (userId: string) =>
          `Bearer ${signJwtHmac({ sub: userId, ...validityWindow() }, 'some-other-secret')}`,
      ],
      [
        'an expired token',
        (userId: string) => {
          const issuedAt = Math.floor(Date.now() / 1_000) - 7_200;

          return `Bearer ${signJwtHmac(
            { sub: userId, iat: issuedAt, exp: issuedAt + 3_600 },
            TEST_JWT_SECRET,
          )}`;
        },
      ],
    ])('rejects %s on every endpoint', async (_description, authorizationFor) => {
      const user = await registerUser(EMAIL);

      await expectEveryEndpointToReject(authorizationFor(user.id));
    });
  });
});

interface Body {
  scheduledAt: string;
}

/** Millisecond precision, matching the column's `Timestamptz(3)`, so the round trip is exact. */
function futureInstant(daysFromNow = 1): string {
  return new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1_000).toISOString();
}

function validityWindow(): { iat: number; exp: number } {
  const now = Math.floor(Date.now() / 1_000);

  return { iat: now, exp: now + 3_600 };
}
