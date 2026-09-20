import { Test } from '@nestjs/testing';

import { PrismaService } from '../../../prisma/prisma.service';
import { FindUserCredentialsByIdQuery } from '../find-user-credentials-by-id.query';
import { FindUserCredentialsByIdHandler } from './find-user-credentials-by-id.handler';

describe('FindUserCredentialsByIdHandler', () => {
  const findUnique = jest.fn();
  let handler: FindUserCredentialsByIdHandler;

  beforeEach(async () => {
    findUnique.mockReset().mockResolvedValue({ id: 'user-id', passwordHash: 'stored-hash' });

    const moduleRef = await Test.createTestingModule({
      providers: [
        FindUserCredentialsByIdHandler,
        { provide: PrismaService, useValue: { user: { findUnique } } },
      ],
    }).compile();

    handler = moduleRef.get(FindUserCredentialsByIdHandler);
  });

  it('selects the id and hash and nothing else', async () => {
    const credentials = await handler.execute(new FindUserCredentialsByIdQuery('user-id'));

    // As in the by-email handler: this query returns a secret on purpose, so it returns as
    // little else as possible.
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'user-id' },
      select: { id: true, passwordHash: true },
    });
    expect(credentials).toEqual({ id: 'user-id', passwordHash: 'stored-hash' });
  });

  it('resolves to null for an id with no row', async () => {
    findUnique.mockResolvedValue(null);

    // The change-password handler turns this into a bare 401: a valid token naming an account
    // that has since been deleted.
    await expect(handler.execute(new FindUserCredentialsByIdQuery('gone'))).resolves.toBeNull();
  });
});
