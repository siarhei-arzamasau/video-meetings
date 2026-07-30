import { randomUUID } from 'node:crypto';

import type { Meeting } from '@repo/shared';
import type request from 'supertest';

import { useAuthSuite } from './utils/auth-suite';
import { EMAIL, PASSWORD, REGISTER_URL, TEST_JWT_SECRET } from './utils/fixtures';
import { accessTokenOf } from './utils/http';
import { signJwtHmac } from './utils/jwt';
import { findUserRow } from './utils/users-table';

const MEETINGS_URL = '/api/meetings';

interface RegisteredUser {
  id: string;
  token: string;
}

describe('Meetings API', () => {
  const suite = useAuthSuite();

  const registerUser = async (email: string): Promise<RegisteredUser> => {
    const response = await suite.post(REGISTER_URL, { email, password: PASSWORD }).expect(201);
    const user = await findUserRow(suite.prisma(), email);

    return { id: user.id, token: accessTokenOf(response) };
  };

  const createMeeting = (token: string, body: object) =>
    suite.post(MEETINGS_URL, body).set('Authorization', `Bearer ${token}`);

  const listMeetings = (token: string) =>
    suite.get(MEETINGS_URL).set('Authorization', `Bearer ${token}`);

  const getMeeting = (token: string, meetingId: string) =>
    suite.get(`${MEETINGS_URL}/${meetingId}`).set('Authorization', `Bearer ${token}`);

  describe(`POST ${MEETINGS_URL}`, () => {
    it('creates a scheduled meeting owned by the current user', async () => {
      const host = await registerUser(EMAIL);
      const grace = await registerUser('grace@example.com');
      const charles = await registerUser('charles@example.com');
      const date = futureDate();

      const response = await createMeeting(host.token, {
        title: 'Analytical Engine planning',
        date,
        participants: [grace.id, charles.id],
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
        scheduledAt: date,
        participantIds: [grace.id, charles.id].toSorted(),
      });
      expect(body.participantIds).toHaveLength(2);
    });

    it('allows a meeting with no participants', async () => {
      const host = await registerUser(EMAIL);

      const response = await createMeeting(host.token, {
        title: 'Private planning',
        date: futureDate(),
        participants: [],
      }).expect(201);
      const body = response.body as Meeting;

      expect(body.participantIds).toEqual([]);
    });

    it.each([
      ['a missing title', ({ date }: { date: string }) => ({ date, participants: [] })],
      ['a blank title', ({ date }: { date: string }) => ({ title: '   ', date, participants: [] })],
      ['a missing date', () => ({ title: 'Planning', participants: [] })],
      ['missing participants', ({ date }: { date: string }) => ({ title: 'Planning', date })],
      [
        'an invalid date',
        () => ({ title: 'Planning', date: 'tomorrow afternoon', participants: [] }),
      ],
      [
        'a non-array participants value',
        ({ date }: { date: string }) => ({ title: 'Planning', date, participants: 'user-id' }),
      ],
      [
        'a non-string participant id',
        ({ date }: { date: string }) => ({ title: 'Planning', date, participants: [123] }),
      ],
      [
        'an unrecognised field',
        ({ date }: { date: string }) => ({
          title: 'Planning',
          date,
          participants: [],
          hostId: randomUUID(),
        }),
      ],
    ])('rejects %s with 400', async (_description, bodyFor) => {
      const host = await registerUser(EMAIL);

      await createMeeting(host.token, bodyFor({ date: futureDate() })).expect(400);
    });

    it('rejects the same participant twice with different UUID casing', async () => {
      const host = await registerUser(EMAIL);
      const participant = await registerUser('grace@example.com');

      await createMeeting(host.token, {
        title: 'Duplicate participant',
        date: futureDate(),
        participants: [participant.id, participant.id.toUpperCase()],
      }).expect(400);

      await listMeetings(host.token).expect(200, []);
    });

    it('rejects an unknown participant without creating the meeting', async () => {
      const host = await registerUser(EMAIL);

      await createMeeting(host.token, {
        title: 'Unknown participant',
        date: futureDate(),
        participants: [randomUUID()],
      }).expect(400);

      await listMeetings(host.token).expect(200, []);
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
      const grace = await registerUser('grace@example.com');
      const charles = await registerUser('charles@example.com');

      const hosted = await createMeeting(ada.token, {
        title: 'Hosted by Ada',
        date: futureDate(1),
        participants: [grace.id],
      }).expect(201);
      const joined = await createMeeting(grace.token, {
        title: 'Hosted by Grace',
        date: futureDate(2),
        participants: [ada.id],
      }).expect(201);
      await createMeeting(charles.token, {
        title: 'Unrelated meeting',
        date: futureDate(3),
        participants: [],
      }).expect(201);

      const response = await listMeetings(ada.token).expect(200);
      const meetings = response.body as Meeting[];

      expect(meetings).toEqual([hosted.body, joined.body]);
    });
  });

  describe(`GET ${MEETINGS_URL}/:id`, () => {
    it('returns the meeting to its host', async () => {
      const host = await registerUser(EMAIL);
      const participant = await registerUser('grace@example.com');
      const created = await createMeeting(host.token, {
        title: 'Engine review',
        date: futureDate(),
        participants: [participant.id],
      }).expect(201);
      const meeting = created.body as Meeting;

      const response = await getMeeting(host.token, meeting.id).expect(200);

      expect(response.body).toEqual(meeting);
    });

    it('returns the meeting to one of its participants', async () => {
      const host = await registerUser(EMAIL);
      const participant = await registerUser('grace@example.com');
      const created = await createMeeting(host.token, {
        title: 'Engine review',
        date: futureDate(),
        participants: [participant.id],
      }).expect(201);
      const meeting = created.body as Meeting;

      const response = await getMeeting(participant.token, meeting.id).expect(200);

      expect(response.body).toEqual(meeting);
    });

    it('returns 404 when the meeting does not exist', async () => {
      const user = await registerUser(EMAIL);
      await createMeeting(user.token, {
        title: 'Existing meeting',
        date: futureDate(),
        participants: [],
      }).expect(201);

      await getMeeting(user.token, randomUUID()).expect(404);
    });

    it('returns 404 when the meeting belongs to another user', async () => {
      const host = await registerUser(EMAIL);
      const otherUser = await registerUser('grace@example.com');
      const created = await createMeeting(host.token, {
        title: 'Host-only meeting',
        date: futureDate(),
        participants: [],
      }).expect(201);
      const meeting = created.body as Meeting;

      await getMeeting(otherUser.token, meeting.id).expect(404);
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

function futureDate(daysFromNow = 1): string {
  return new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1_000).toISOString();
}

function validityWindow(): { iat: number; exp: number } {
  const now = Math.floor(Date.now() / 1_000);

  return { iat: now, exp: now + 3_600 };
}
