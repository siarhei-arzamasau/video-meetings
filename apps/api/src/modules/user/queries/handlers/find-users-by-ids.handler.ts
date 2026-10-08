import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';

import { PrismaService } from '../../../prisma/prisma.service';
import { FindUsersByIdsQuery } from '../find-users-by-ids.query';
import type { UserDisplayName } from '../find-users-by-ids.query';

/**
 * One statement for however many ids, selecting the two columns the answer is made of. The
 * `select` is the rule, not an optimisation: a row loaded whole and mapped down would have
 * held an email address and a password hash on its way to a caller that is owed neither.
 */
@QueryHandler(FindUsersByIdsQuery)
export class FindUsersByIdsHandler implements IQueryHandler<
  FindUsersByIdsQuery,
  UserDisplayName[]
> {
  constructor(private readonly prisma: PrismaService) {}

  async execute({ userIds }: FindUsersByIdsQuery): Promise<UserDisplayName[]> {
    if (userIds.length === 0) {
      return [];
    }

    return this.prisma.user.findMany({
      where: { id: { in: [...new Set(userIds)] } },
      select: { id: true, displayName: true },
    });
  }
}
