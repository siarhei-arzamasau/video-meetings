import { Test } from '@nestjs/testing';

import { PrismaService } from '../../../prisma/prisma.service';
import { FindUserByIdQuery } from '../find-user-by-id.query';
import { FindUserByIdHandler } from './find-user-by-id.handler';

const USER_ID = '11111111-2222-3333-4444-555555555555';

describe('FindUserByIdHandler', () => {
  const findUnique = jest.fn();
  let handler: FindUserByIdHandler;

  beforeEach(async () => {
    findUnique.mockReset().mockResolvedValue({
      id: USER_ID,
      email: 'ada@example.com',
      displayName: 'ada',
      createdAt: new Date('2026-07-30T12:00:00.000Z'),
      passwordHash: 'stored-hash',
    });

    const moduleRef = await Test.createTestingModule({
      providers: [
        FindUserByIdHandler,
        { provide: PrismaService, useValue: { user: { findUnique } } },
      ],
    }).compile();

    handler = moduleRef.get(FindUserByIdHandler);
  });

  it('returns the public user for a stored row', async () => {
    const user = await handler.execute(new FindUserByIdQuery(USER_ID));

    expect(findUnique).toHaveBeenCalledWith({ where: { id: USER_ID } });
    expect(user).toEqual({
      id: USER_ID,
      email: 'ada@example.com',
      displayName: 'ada',
      createdAt: '2026-07-30T12:00:00.000Z',
    });
  });

  it('never lets the stored hash out', async () => {
    // The guard attaches this result to the request, so anything returned here is one
    // `res.json(user)` away from a response body.
    await expect(handler.execute(new FindUserByIdQuery(USER_ID))).resolves.not.toHaveProperty(
      'passwordHash',
    );
  });

  it('resolves to null for an unknown id rather than throwing', async () => {
    findUnique.mockResolvedValue(null);

    // What a missing user means is the caller's decision — the guard turns this into a 401.
    await expect(handler.execute(new FindUserByIdQuery(USER_ID))).resolves.toBeNull();
  });
});
