import { NotFoundException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';

import { VisibleMeetingGuard } from './visible-meeting.guard';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const MEETING_ID = '44444444-4444-4444-8444-444444444444';

const MEETING = {
  id: MEETING_ID,
  title: 'Engine review',
  status: 'scheduled',
  hostId: USER_ID,
  scheduledAt: '2026-08-01T10:00:00.000Z',
  participantIds: [],
};

/** Only the two things the guard reads off the request. */
const contextFor = (params: Record<string, string>, user?: { id: string }): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ params, user }) }),
  }) as unknown as ExecutionContext;

describe('VisibleMeetingGuard', () => {
  const execute = jest.fn();
  let guard: VisibleMeetingGuard;

  beforeEach(async () => {
    execute.mockReset().mockResolvedValue(MEETING);

    const moduleRef = await Test.createTestingModule({
      providers: [VisibleMeetingGuard, { provide: QueryBus, useValue: { execute } }],
    }).compile();

    guard = moduleRef.get(VisibleMeetingGuard);
  });

  it('lets a caller who can see the meeting through', async () => {
    await expect(guard.canActivate(contextFor({ id: MEETING_ID }, { id: USER_ID }))).resolves.toBe(
      true,
    );

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('answers 404 Meeting not found for a stranger', async () => {
    execute.mockResolvedValue(null);

    await expect(
      guard.canActivate(contextFor({ id: MEETING_ID }, { id: USER_ID })),
    ).rejects.toThrow(new NotFoundException('Meeting not found'));
  });

  it('leaves a malformed id to ParseUUIDPipe rather than dispatching it', async () => {
    // A non-UUID against a `uuid` column makes Postgres raise, which would be a 500 where the
    // pipe's synchronous 400 belongs. The pipe runs after this guard and answers it.
    await expect(
      guard.canActivate(contextFor({ id: 'not-a-uuid' }, { id: USER_ID })),
    ).resolves.toBe(true);

    expect(execute).not.toHaveBeenCalled();
  });

  it('does nothing when no user is on the request', async () => {
    // `JwtAuthGuard` is declared on the controller and therefore runs first; without a caller
    // there is nobody to resolve visibility for, and the 401 has already been decided.
    await expect(guard.canActivate(contextFor({ id: MEETING_ID }))).resolves.toBe(true);

    expect(execute).not.toHaveBeenCalled();
  });
});
