import { Test } from '@nestjs/testing';

import { PrismaService } from '../../../prisma/prisma.service';
import { FindUsersByIdsQuery } from '../find-users-by-ids.query';
import { FindUsersByIdsHandler } from './find-users-by-ids.handler';

const ADA_ID = '11111111-1111-4111-8111-111111111111';
const GRACE_ID = '22222222-2222-4222-8222-222222222222';
const NOBODY_ID = '99999999-9999-4999-8999-999999999999';

describe('FindUsersByIdsHandler', () => {
  const findMany = jest.fn();
  let handler: FindUsersByIdsHandler;

  beforeEach(async () => {
    findMany.mockReset().mockResolvedValue([
      { id: ADA_ID, displayName: 'Ada Lovelace' },
      { id: GRACE_ID, displayName: 'grace' },
    ]);

    const moduleRef = await Test.createTestingModule({
      providers: [
        FindUsersByIdsHandler,
        { provide: PrismaService, useValue: { user: { findMany } } },
      ],
    }).compile();

    handler = moduleRef.get(FindUsersByIdsHandler);
  });

  it('answers the id and display name of every user asked for, in one statement', async () => {
    await expect(handler.execute(new FindUsersByIdsQuery([ADA_ID, GRACE_ID]))).resolves.toEqual([
      { id: ADA_ID, displayName: 'Ada Lovelace' },
      { id: GRACE_ID, displayName: 'grace' },
    ]);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('selects the id and the display name and no other column', async () => {
    await handler.execute(new FindUsersByIdsQuery([ADA_ID, GRACE_ID]));

    // The whole argument: an email address or a hash that was loaded is one that can leak,
    // and this is the one read that hands a user's name to somebody else.
    expect(findMany).toHaveBeenCalledWith({
      where: { id: { in: [ADA_ID, GRACE_ID] } },
      select: { id: true, displayName: true },
    });
  });

  it('asks for an id once however often it was named', async () => {
    await handler.execute(new FindUsersByIdsQuery([ADA_ID, GRACE_ID, ADA_ID]));

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: [ADA_ID, GRACE_ID] } } }),
    );
  });

  it('leaves an id that names nobody out of the answer rather than throwing', async () => {
    findMany.mockResolvedValue([{ id: ADA_ID, displayName: 'Ada Lovelace' }]);

    await expect(handler.execute(new FindUsersByIdsQuery([ADA_ID, NOBODY_ID]))).resolves.toEqual([
      { id: ADA_ID, displayName: 'Ada Lovelace' },
    ]);
  });

  it('answers nobody for no ids, without a statement', async () => {
    await expect(handler.execute(new FindUsersByIdsQuery([]))).resolves.toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});
