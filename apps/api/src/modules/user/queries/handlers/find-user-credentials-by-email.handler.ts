import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';

import { PrismaService } from '../../../prisma/prisma.service';
import { FindUserCredentialsByEmailQuery } from '../find-user-credentials-by-email.query';
import type { UserCredentials } from '../user-credentials';

@QueryHandler(FindUserCredentialsByEmailQuery)
export class FindUserCredentialsByEmailHandler implements IQueryHandler<
  FindUserCredentialsByEmailQuery,
  UserCredentials | null
> {
  constructor(private readonly prisma: PrismaService) {}

  async execute({ email }: FindUserCredentialsByEmailQuery): Promise<UserCredentials | null> {
    // An explicit `select` rather than the whole row. This is the one query that returns a
    // hash on purpose, so it returns as little else as possible — and a column added to the
    // model later cannot join the payload by default.
    return this.prisma.user.findUnique({
      where: { email },
      select: { id: true, passwordHash: true },
    });
  }
}
