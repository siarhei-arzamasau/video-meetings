import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import type { User } from '@repo/shared';

import { PrismaService } from '../../../prisma/prisma.service';
import { toPublicUser } from '../../services/user.mapper';
import { FindUserByIdQuery } from '../find-user-by-id.query';

@QueryHandler(FindUserByIdQuery)
export class FindUserByIdHandler implements IQueryHandler<FindUserByIdQuery, User | null> {
  constructor(private readonly prisma: PrismaService) {}

  async execute({ userId }: FindUserByIdQuery): Promise<User | null> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    // `null`, not a 404: a missing user means different things to different callers, and the
    // one caller there is turns it into a 401. A `NotFoundException` here would make that
    // decision for it.
    return user === null ? null : toPublicUser(user);
  }
}
