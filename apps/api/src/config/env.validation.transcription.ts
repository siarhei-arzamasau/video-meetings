import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

import { parseBoolean } from './env-values';
import { DEFAULT_TRANSCRIPTION_TIMEOUT_SECONDS } from './transcription.defaults';

/**
 * The transcription part of the environment contract: `EnvironmentVariables` in
 * `env.validation.ts` extends this, and `validate` there is what checks it. Nothing reads
 * this class on its own.
 */
export class TranscriptionEnvironmentVariables {
  /**
   * Whether an audio or video file is queued for transcription when it becomes `ready`, and
   * whether the transcription worker claims anything. Off by default: it needs a second service.
   * Switching it off keeps every stored status and leaves a queued recording waiting for it to
   * come back. Parsed like the worker flag, for the same reason. The URL below is validated
   * whenever this is on — its shape, never the server behind it: a Whisper that is down fails a
   * transcription, not the boot of what serves every upload.
   */
  @Transform(({ obj, key }) => parseBoolean((obj as Record<string, unknown>)[key]))
  @IsBoolean()
  MEETING_FILES_TRANSCRIPTION_ENABLED: boolean = false;

  /**
   * An OpenAI-compatible `audio/transcriptions` endpoint: the `whisper` Compose service, at
   * `http://localhost:8000/v1/audio/transcriptions` from the host and `http://whisper:8000/…`
   * from the `api` container. Required when the flag is on, and unvalidated when it is off so
   * a deployment that does not transcribe needs no placeholder.
   */
  @ValidateIf((env: TranscriptionEnvironmentVariables) => env.MEETING_FILES_TRANSCRIPTION_ENABLED)
  @IsUrl({ require_tld: false, require_protocol: true, protocols: ['http', 'https'] })
  TRANSCRIPTION_API_URL: string = '';

  /** Sent as a bearer token when set. Optional: a server on a private network may want none. */
  @IsOptional()
  @IsString()
  TRANSCRIPTION_API_KEY?: string;

  /**
   * The `model` field of the request. Required when the flag is on and **never defaulted**: no
   * one name is right everywhere — the local service answers 404 for a model it has not
   * downloaded, a hosted endpoint for one it does not have — so a default fails every
   * recording somewhere, one at a time and long after boot. `.env.example` and Compose name
   * Whisper `small` as the local service knows it (its `WHISPER_MODEL`).
   */
  @ValidateIf((env: TranscriptionEnvironmentVariables) => env.MEETING_FILES_TRANSCRIPTION_ENABLED)
  @MinLength(1, {
    message: 'TRANSCRIPTION_MODEL must be set when MEETING_FILES_TRANSCRIPTION_ENABLED is on.',
  })
  TRANSCRIPTION_MODEL: string = '';

  /**
   * How long one transcription may take before it is aborted and ends Failed with a reason naming
   * this limit — the file stays `ready` — rather than hanging on a lease that keeps being renewed.
   * Twelve minutes by default: a one-hour recording at twice the rate measured beside the constant.
   * At least thirty seconds: a bound shorter than the request it bounds only fails transcriptions.
   */
  @IsInt()
  @Min(30)
  TRANSCRIPTION_TIMEOUT_SECONDS: number = DEFAULT_TRANSCRIPTION_TIMEOUT_SECONDS;
}
