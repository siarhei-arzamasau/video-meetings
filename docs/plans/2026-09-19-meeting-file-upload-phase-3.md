# Meeting File Upload — Phase 3 Implementation Plan

**PRD:** [`docs/specs/2026-09-19-meeting-file-upload-prd.md`](../specs/2026-09-19-meeting-file-upload-prd.md) — _Phasing_, row 3: "Retry from the UI for `failed`; a transcription step for audio and video behind a flag."
**Date:** 2026-09-19
**Depends on:** the [Phase 1 plan](2026-09-19-meeting-file-upload-phase-1.md) landed in full. Independent of Phases 2 and 4.

**Goal:** two things the Phase 1 state machine and pipeline were shaped for but did not use. First, a `failed` file can be sent back through the pipeline from the meeting page, using the `failed → uploaded` transition the PRD reserved for "an explicit retry". Second, audio and video files gain a transcription step, added to the pipeline as one more entry and switched off by default, so the platform's first AI processing arrives without touching the state machine or the API.

**Method:** the Phase 1 _Test-first protocol_ and _Global Constraints_ apply unchanged.

## Assumptions the PRD does not settle

1. **Who may retry: the uploader or the host.** The same rule as delete (PRD F5), for the same reason: they are the two people with standing over the file. Anyone else gets 404, never 403.
2. **Retry resets `attempts` to 0 and clears `failureReason`.** A retry is a fresh chance, not a fourth attempt against the Phase 1 cap of three.
3. **Transcription provider: an HTTP adapter to an OpenAI-compatible `audio/transcriptions` endpoint**, configured by `TRANSCRIPTION_API_URL` and `TRANSCRIPTION_API_KEY`. That interface is served by hosted providers and by self-hosted Whisper servers alike, so the choice of vendor is configuration. The step talks to a `TranscriptionProvider` port; the HTTP adapter is the only implementation, and tests use a fake. This is the one assumption that changes real code if product prefers a different provider, so confirm it before Phase 3.3.
4. **The transcript is stored as plain text beside the object** at `<storageKey>.transcript.txt` and served from `GET /api/meetings/:id/files/:fileId/transcript`, the way a thumbnail is served from its own route. The PRD names no transcript UI, so this plan adds none; the route exists so the step's output is observable and testable, and so a later phase can build on it.
5. **The step is skipped, not failed, when the flag is off.** A file uploaded while `MEETING_FILES_TRANSCRIPTION_ENABLED=false` reaches `ready` without a transcript. Turning the flag on later does not reprocess existing files; a user can retry one by hand once retry exists.

## Design constraints

- **Retry is a state transition, not a re-upload.** `POST .../retry` calls the repository's `transition(id, 'failed', 'uploaded', { attempts: 0, failureReason: null, processedAt: null })`. The worker then claims the row like any other `uploaded` file. A zero-row update means the file is no longer `failed` and answers 409.
- **The pipeline stays a list.** `PIPELINE` becomes `[verifyStep, previewStep, transcribeStep]`. Nothing in the worker, the state machine, or the controller changes for the step to exist; that is the PRD's F8 promise, and this phase is the first test of it.
- **A slow step must keep its lease.** Transcribing an hour of audio can exceed the 60 second lease. The worker gains a heartbeat: while a step runs it extends `leased_until` every `lease / 3` seconds through `MeetingFileRepository.renewLease(id, leaseSeconds)`, which is a conditional update on `status = 'processing'` and reports whether the row was still ours. A lost lease stops the step's result from being written, as Phase 1's zero-row transition rule already requires.
- **The provider never sees a path it can traverse.** The step opens the object through `MeetingFileStorage.openRead` and streams it to the provider; the provider returns text. Failures are `StepError('The recording could not be transcribed')`; a timeout (`TRANSCRIPTION_TIMEOUT_SECONDS`, default `600`) is a `StepError` too, so the user sees a specific reason rather than the generic fallback.
- **The flag is read per tick, not at boot**, so a deployment can enable transcription without a restart. It is still an env variable validated in `env.validation.ts`; "per tick" means the step checks `ConfigService` when it runs.

## Contract additions (`@repo/shared`)

```ts
export interface MeetingFile {
  // …Phase 1 fields…
  /** Present when a transcript exists; a relative API path. */
  transcriptPath?: string;
}
```

## Routes

| Method | Path                                         | Who                 | Result                                                         |
| ------ | -------------------------------------------- | ------------------- | -------------------------------------------------------------- |
| `POST` | `/api/meetings/:id/files/:fileId/retry`      | uploader or host    | `200 MeetingFile` with status `uploaded`, no `failureReason`   |
| `GET`  | `/api/meetings/:id/files/:fileId/transcript` | host or participant | `200 text/plain; charset=utf-8`, inline, `nosniff`, `no-store` |

| Case                                 | Status | Message                             |
| ------------------------------------ | ------ | ----------------------------------- |
| Retry by another participant         | 404    | `File not found`                    |
| Retry of a file that is not `failed` | 409    | `Only a failed file can be retried` |
| Transcript requested, none exists    | 404    | `Transcript not found`              |
| Meeting not visible                  | 404    | `Meeting not found`                 |

## Implementation phases

### Phase 3.1: Retry in the API

**Goal:** a `failed` file can be sent back through the pipeline with one request. The state machine's reserved transition gets its first caller.
**Touches:** backend

**Tasks:**

- [ ] `RetryMeetingFileCommand(userId, meetingId, fileId)` and handler: resolve the visible meeting (404), load the non-deleted file (404), check uploader-or-host (404), then the conditional transition described above (409 on zero rows). Returns the mapped file. Unit spec for the four outcomes.
- [ ] `POST :fileId/retry` on `MeetingFilesController`, same guard and pipes as the other routes; the state machine spec gains the `failed → uploaded` row as an allowed transition with a comment naming this route as its caller.
- [ ] E2E spec `test/meeting-files-retry.e2e-spec.ts`, red first: upload a PNG, truncate the object, `drain()` → `failed`; retry as uploader → 200 with status `uploaded`, `attempts = 0`, `failure_reason` null; `drain()` → `failed` again (the object is still truncated), proving the file really went through the pipeline; restore the object, retry, `drain()` → `ready` with a checksum; retry as host of a participant's file → 200; retry as another participant → 404 and the row unchanged; retry a `ready` file → 409; retry a `deleted` file → 404; stranger → 404 `Meeting not found`.

**Done when:** the retry spec is green with every Phase 1 e2e spec unmodified, the unit suite is green, and the API guide's meeting-files section names retry as the one caller of `failed → uploaded`.

### Phase 3.2: Retry on the meeting page

**Goal:** the warning chip on a failed row offers Retry; the row returns to Processing and the poll resumes until the file is `ready` or `failed` again.
**Touches:** frontend

**Tasks:**

- [ ] `api-client.ts`: `retryMeetingFile(token, meetingId, fileId): Promise<MeetingFile>` with a Vitest test for the 200 and the 409 message.
- [ ] `FileRow`: when `status` is `failed` and the viewer is the uploader or the host, a Retry action beside Delete; in flight it is disabled with a spinner; on success the row's file is replaced in the list and `isProcessing` becomes true so the 3 second poll restarts; on 409 the list is refreshed (someone else already retried); on any other error the API's message shows inline with Dismiss, using the upload-row error pattern.
- [ ] Playwright spec `apps/web/e2e/meeting-files-retry.spec.ts`, red first: upload a PNG through the UI, truncate the object on disk through a test-only helper that reads `MEETING_FILES_DIR` from the `start:e2e-web` script's environment, wait for the warning chip with the incomplete-file reason in its tooltip; click Retry → the Processing chip appears → the warning chip returns (still truncated); restore the object, Retry → within 10 seconds no chip and a thumbnail; as another participant the failed row shows no Retry; keyboard path Tab → Retry → Enter works.

**Done when:** the spec is green with the Phase 1 browser suite; Vitest green; browser inspection in both themes recorded in the commit body; the web guide's meeting page section mentions the Retry action and that it is gated the same way as Delete.

### Phase 3.3: The transcription step

**Goal:** with the flag on, an audio or video file reaches `ready` with a transcript stored beside it and served from the API. With the flag off, nothing changes for anyone.
**Touches:** backend, database

**Tasks:**

- [ ] Schema: `transcriptKey String? @map("transcript_key")` on `MeetingFile`, migration `add_meeting_file_transcript`, the mapper sets `transcriptPath` when it is non-null, the shared contract gains the field. Env: `MEETING_FILES_TRANSCRIPTION_ENABLED` (boolean, default `false`, with the Phase 1 `@Transform` for `'false'`), `TRANSCRIPTION_API_URL` (URL, required when the flag is on — a custom validator), `TRANSCRIPTION_API_KEY` (string, optional), `TRANSCRIPTION_TIMEOUT_SECONDS` (default `600`, `@Min(30)`); `env.validation.spec.ts` covers "flag on without a URL fails boot".
- [ ] `TranscriptionProvider` port (`transcribe(stream, contentType, signal): Promise<string>`) and the HTTP adapter in `processing/transcription/`, with a unit spec against a local `http.createServer` fake: multipart body, bearer header when a key is set, timeout → abort → `StepError`, non-2xx → `StepError`, response text returned verbatim.
- [ ] `TranscribeStep`: skip unless the flag is on and `contentType` starts with `audio/` or `video/`; stream the object to the provider; write the text to `storage.pathOf(`${key}.transcript.txt`)`; return `{ transcriptKey }`. Appended to `PIPELINE`. The worker's heartbeat (`renewLease`) is added in the same task, with a unit spec that a step running longer than `lease / 3` renews it and that a step whose renewal reports zero rows has its patch discarded.
- [ ] `GET :fileId/transcript` on the controller, served through `StreamableFile` with the headers above; purge (deleted files) and the storage key regex cover the `.transcript.txt` suffix.
- [ ] E2E spec `test/meeting-files-transcription.e2e-spec.ts`, red first, with a fake provider bound in the test through a string token so the spec compiles before the step exists: flag off (the `setup-env.ts` default) → an MP3 fixture reaches `ready` with no `transcript_key`; flag on via `ConfigService` override → `ready`, `transcript_key = '<key>.transcript.txt'`, the file on disk holds the fake's text, `GET transcript` returns it as `text/plain` with `nosniff`; a PDF with the flag on gets no transcript; the fake throwing → `failed` with `The recording could not be transcribed`; the fake hanging past a 2 second test timeout → the same reason, and `leased_until` was renewed at least once during the wait (read it mid-step); deleting the file → `drain()` removes object, thumbnail, and transcript; a stranger gets 404 from the transcript route.

**Done when:** the transcription spec is green with every earlier e2e spec; a manual run with the flag on against a real endpoint is recorded in the commit body with the duration logged by the worker; `pnpm build && pnpm typecheck && pnpm test` pass; the API guide documents the flag, the provider port, the heartbeat, and that the flag is checked per tick.

## Documentation owed

- Root guide and `README.md`: the four new env variables with one line each, and that transcription is off by default.
- API guide: retry as the caller of the reserved transition, the heartbeat and why it exists, the provider port, and the transcript key layout.
- Web guide: the Retry action and its gate.

## Out of scope

- Displaying, searching, or downloading the transcript from the meeting page. The PRD's Phase 3 line names a step, not a UI; the route exists so the step is observable.
- Summarisation or any further AI step. Each is one more `PIPELINE` entry when it comes.
- Reprocessing files uploaded before the flag was turned on.
- Retrying a chunked-upload session (Phase 2 owns that).
