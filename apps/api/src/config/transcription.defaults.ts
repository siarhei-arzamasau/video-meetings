/**
 * The transcription default that is read in more than one place: by the environment contract,
 * and as the fallback of the code that asks `ConfigService` for it. Stated once, so the value
 * a spec's bare config falls back to is the value a deployment boots with.
 *
 * `apps/api/.env.example` and `docker-compose.yml` restate it, because neither can import.
 * The model has no default at all: see `TRANSCRIPTION_MODEL` in `env.validation.ts`.
 */

/**
 * Twelve minutes: a one-hour recording at twice the slowest rate measured, rounded up.
 *
 * Measured on 2026-10-07 against the `whisper` Compose service (Speaches 0.9.0-rc.3, CPU image,
 * `small`, its default four threads) under Docker Desktop on an 18-core Apple Silicon laptop,
 * through this API, with the time taken from the worker's log line:
 *
 * | Recording          | Work            | Per minute of audio |
 * | ------------------ | --------------- | ------------------- |
 * | 4 s reference, MP3 | 2.7 – 3.6 s     | a fixed cost        |
 * | 10 minutes, MP3    | 52.6 – 59.7 s   | 5.3 – 6.0 s         |
 * | 60 minutes, MP3    | 318.3 – 331.6 s | 5.3 – 5.5 s         |
 *
 * 60 minutes × 6.0 s × 2 = 716 s. The rate is the host's, not the model's: a slower machine,
 * or recordings much longer than an hour, want a larger `TRANSCRIPTION_TIMEOUT_SECONDS`.
 */
export const DEFAULT_TRANSCRIPTION_TIMEOUT_SECONDS = 720;
