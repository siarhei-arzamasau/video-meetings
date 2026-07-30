import { Test } from '@nestjs/testing';

import { PrismaService } from '../../../prisma/prisma.service';
import { FindUserCredentialsByEmailQuery } from '../find-user-credentials-by-email.query';
import { FindUserCredentialsByEmailHandler } from './find-user-credentials-by-email.handler';

describe('FindUserCredentialsByEmailHandler', () => {
  const findUnique = jest.fn();
  let handler: FindUserCredentialsByEmailHandler;

  beforeEach(async () => {
    findUnique.mockReset().mockResolvedValue({ id: 'user-id', passwordHash: 'stored-hash' });

    const moduleRef = await Test.createTestingModule({
      providers: [
        FindUserCredentialsByEmailHandler,
        { provide: PrismaService, useValue: { user: { findUnique } } },
      ],
    }).compile();

    handler = moduleRef.get(FindUserCredentialsByEmailHandler);
  });

  it('selects the id and hash and nothing else', async () => {
    const credentials = await handler.execute(
      new FindUserCredentialsByEmailQuery('ada@example.com'),
    );

    // The explicit `select` is the point: this query returns a secret, so a column added to
    // the model later must not join the payload on its own.
    expect(findUnique).toHaveBeenCalledWith({
      where: { email: 'ada@example.com' },
      select: { id: true, passwordHash: true },
    });
    expect(credentials).toEqual({ id: 'user-id', passwordHash: 'stored-hash' });
  });

  it('resolves to null for an unknown address', async () => {
    findUnique.mockResolvedValue(null);

    // Login turns this into the shared 401 — and spends verification work first, so the
    // absence of a row is not visible in the response time.
    await expect(
      handler.execute(new FindUserCredentialsByEmailQuery('nobody@example.com')),
    ).resolves.toBeNull();
  });
});
