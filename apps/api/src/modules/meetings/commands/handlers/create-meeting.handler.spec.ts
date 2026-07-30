import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { Prisma } from '../../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateMeetingCommand } from '../create-meeting.command';
import { CreateMeetingHandler } from './create-meeting.handler';

const HOST_ID = '11111111-1111-4111-8111-111111111111';
const GRACE_ID = '22222222-2222-4222-8222-222222222222';
const CHARLES_ID = '33333333-3333-4333-8333-333333333333';

describe('CreateMeetingHandler', () => {
  const create = jest.fn();
  let handler: CreateMeetingHandler;

  beforeEach(async () => {
    create.mockReset().mockResolvedValue({
      id: 'meeting-id',
      title: 'Analytical Engine planning',
      status: 'scheduled',
      hostId: HOST_ID,
      scheduledAt: new Date('2026-08-01T10:00:00.000Z'),
      participants: [{ userId: GRACE_ID }, { userId: CHARLES_ID }],
    });

    const moduleRef = await Test.createTestingModule({
      providers: [
        CreateMeetingHandler,
        { provide: PrismaService, useValue: { meeting: { create } } },
      ],
    }).compile();

    handler = moduleRef.get(CreateMeetingHandler);
  });

  const command = new CreateMeetingCommand(
    HOST_ID,
    'Analytical Engine planning',
    '2026-08-01T10:00:00.000Z',
    [GRACE_ID, CHARLES_ID],
  );

  it('stores the instant as a Date and one participant row per id', async () => {
    await handler.execute(command);

    expect(create).toHaveBeenCalledWith({
      data: {
        title: 'Analytical Engine planning',
        scheduledAt: new Date('2026-08-01T10:00:00.000Z'),
        hostId: HOST_ID,
        participants: { create: [{ userId: GRACE_ID }, { userId: CHARLES_ID }] },
      },
      include: expect.anything(),
    });
  });

  it('takes the host from the command, never from the participant list', async () => {
    await handler.execute(
      new CreateMeetingCommand(HOST_ID, 'Solo', '2026-08-01T10:00:00.000Z', []),
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ hostId: HOST_ID, participants: { create: [] } }),
      }),
    );
  });

  it('rejects the host appearing in their own participant list, writing nothing', async () => {
    // The DTO cannot catch this: it never sees the host. Enforced here, before the insert.
    await expect(
      handler.execute(
        new CreateMeetingCommand(HOST_ID, 'Self-invite', '2026-08-01T10:00:00.000Z', [
          GRACE_ID,
          HOST_ID,
        ]),
      ),
    ).rejects.toThrow(BadRequestException);

    expect(create).not.toHaveBeenCalled();
  });

  it('returns the meeting with the timestamp as an ISO instant', async () => {
    const meeting = await handler.execute(command);

    expect(meeting).toEqual({
      id: 'meeting-id',
      title: 'Analytical Engine planning',
      status: 'scheduled',
      hostId: HOST_ID,
      scheduledAt: '2026-08-01T10:00:00.000Z',
      participantIds: [GRACE_ID, CHARLES_ID],
    });
  });

  it('maps a participant foreign-key violation to a 400', async () => {
    create.mockRejectedValue(foreignKeyViolation('meeting_participants_user_id_fkey'));

    await expect(handler.execute(command)).rejects.toThrow(
      new BadRequestException('Every participant must be a registered user'),
    );
  });

  it('treats a foreign-key violation with an unrecognised meta shape as a bad request', async () => {
    // The participant list is the overwhelmingly likely cause, so an unfamiliar driver
    // payload must not turn the common case into a 500.
    create.mockRejectedValue(foreignKeyViolation(undefined));

    await expect(handler.execute(command)).rejects.toThrow(BadRequestException);
  });

  it('does not blame the participants when the host row is what vanished', async () => {
    // The caller's account was deleted between the guard's lookup and this insert. That is a
    // server-side race, not a malformed request, so it must not surface as a 400.
    create.mockRejectedValue(foreignKeyViolation('meetings_host_id_fkey'));

    await expect(handler.execute(command)).rejects.not.toThrow(BadRequestException);
  });

  it('lets any other database error through untouched', async () => {
    create.mockRejectedValue(new Error('connection reset'));

    await expect(handler.execute(command)).rejects.toThrow('connection reset');
  });
});

/**
 * The `meta` a real `@prisma/adapter-pg` P2003 carries, captured from Postgres rather than
 * imagined. The constraint name sits several levels down and is repeated in the message; a
 * flatter stand-in would let a handler that only reads `meta.field_name` pass here and
 * misclassify every violation in production.
 */
function foreignKeyViolation(constraint: string | undefined): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Foreign key constraint violated', {
    code: 'P2003',
    clientVersion: '7.9.1',
    meta: {
      modelName: 'Meeting',
      ...(constraint === undefined
        ? {}
        : {
            driverAdapterError: {
              name: 'DriverAdapterError',
              cause: {
                originalCode: '23503',
                originalMessage: `insert or update on table violates foreign key constraint "${constraint}"`,
                kind: 'ForeignKeyConstraintViolation',
                constraint: { index: constraint },
              },
            },
          }),
    },
  });
}
