import type { CreateMeetingRequest } from '@repo/shared';
import { Transform, TransformFnParams } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsISO8601,
  IsNotEmpty,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

/** Bounds the column and the work done validating it, as the auth DTOs bound theirs. */
export const MAX_TITLE_LENGTH = 200;

/** One entry is one row. Without a ceiling a single request writes unbounded participants. */
export const MAX_PARTICIPANTS = 100;

/**
 * A full instant, not a bare calendar date. `IsISO8601` alone accepts `2026-07-30`, which
 * parses to midnight UTC — so the response would echo a `scheduledAt` the caller never sent,
 * and "the 30th" would silently mean one thing in Auckland and another in Los Angeles. The
 * three-digit cap on the fraction matches the column's `Timestamptz(3)` precision.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

export class CreateMeetingDto implements CreateMeetingRequest {
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_TITLE_LENGTH)
  title: string;

  @IsISO8601({ strict: true })
  @Matches(ISO_INSTANT, { message: 'scheduledAt must be an ISO 8601 instant, including a time' })
  scheduledAt: string;

  @Transform(normalizeParticipantIds)
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(MAX_PARTICIPANTS)
  @IsString({ each: true })
  @IsUUID('4', { each: true })
  participantIds: string[];
}

/** Preserve non-strings so `@IsString()` can reject them instead of coercing input. */
function trimString({ value }: TransformFnParams): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/**
 * Lowercase before `@ArrayUnique` runs, so one id in two casings is one participant and is
 * rejected as the duplicate it is. It is also what makes the database's `ORDER BY user_id`
 * agree with a plain string sort, which the e2e spec relies on.
 */
function normalizeParticipantIds({ value }: TransformFnParams): unknown {
  if (!Array.isArray(value)) {
    return value;
  }

  return value.map((participant) =>
    typeof participant === 'string' ? participant.toLowerCase() : participant,
  );
}
