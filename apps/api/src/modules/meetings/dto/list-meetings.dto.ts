import { MAX_MEETINGS_LIMIT, MEETINGS_ORDERS } from '@repo/shared';
import type { MeetingsOrder } from '@repo/shared';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * The query of `GET /meetings`. Both parameters are optional, and without them the answer is
 * the one this route always gave: every meeting the user hosts or attends, ascending.
 *
 * `@Type(() => Number)` because a query value arrives as a string and the global pipe does not
 * convert implicitly — see `configure-app.ts` for why it must not.
 */
export class ListMeetingsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_MEETINGS_LIMIT)
  limit?: number;

  @IsOptional()
  @IsIn(MEETINGS_ORDERS)
  order?: MeetingsOrder;
}
