import { Transform, TransformFnParams } from 'class-transformer';
import { ArrayUnique, IsArray, IsDateString, IsNotEmpty, IsString, IsUUID } from 'class-validator';

export class CreateMeetingDto {
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  title: string;

  @IsDateString()
  date: string;

  @Transform(normalizeParticipantIds)
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  @IsUUID('4', { each: true })
  participants: string[];
}

/** Preserve non-strings so `@IsString()` can reject them instead of coercing input. */
function trimString({ value }: TransformFnParams): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

function normalizeParticipantIds({ value }: TransformFnParams): unknown {
  if (!Array.isArray(value)) {
    return value;
  }

  return value.map((participant) =>
    typeof participant === 'string' ? participant.toLowerCase() : participant,
  );
}
