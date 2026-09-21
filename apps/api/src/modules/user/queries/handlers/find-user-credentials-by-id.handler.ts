import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';

import { PrismaService } from '../../../prisma/prisma.service';
import { FindUserCredentialsByIdQuery } from '../find-user-credentials-by-id.query';
import type { UserCredentials } from '../user-credentials';

@QueryHandler(FindUserCredentialsByIdQuery)
export class FindUserCredentialsByIdHandler implements IQueryHandler<
  FindUserCredentialsByIdQuery,
  UserCredentials | null
> {
  constructor(private readonly prisma: PrismaService) {}

  async execute({ userId }: FindUserCredentialsByIdQuery): Promise<UserCredentials | null> {
    // An explicit `select`, as in the by-email handler: this is a query that returns a hash on
    // purpose, so it returns as little else as possible and a column added to the model later
    // cannot join the payload by default.
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, passwordHash: true },
    });
  }
}
