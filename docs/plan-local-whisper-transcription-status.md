# Local Whisper transcription with status — Implementation Plan

**PRD:** [`docs/prd-local-whisper-transcription-status.md`](prd-local-whisper-transcription-status.md)
**Date:** 2026-10-07

Where the code stands: transcription exists as the pipeline's third step, off by default, behind
an OpenAI-compatible HTTP adapter. A recording is `processing` until its transcript is written, a
transcription failure fails the file, and the web app shows nothing about transcripts. Phase 1
keeps that contract and makes it run on a local Whisper; phases 2–5 replace it with the PRD's.

## Decisions the PRD leaves to the plan

1. **Whisper is [Speaches](https://speaches.ai) in Docker Compose, behind an opt-in profile**
   (product's call, 2026-10-07). It serves the OpenAI `audio/transcriptions` shape, so
   `HttpTranscriptionProvider` is reused unchanged; it decodes MP4 and WebM itself, so the API
   image stays ffmpeg-free; its `latest-cpu` image ships `linux/arm64`. A profile, because
   `scripts/start.mjs` runs `docker compose up -d postgres` and must keep starting only that.
2. **Switching the setting off keeps what is stored** (product's call, 2026-10-07). It stops new
   work and nothing else: a Transcribed row keeps its link, a Failed row its reason, and a Queued
   row waits for the setting to come back. A deployment that never had it on has no status
   anywhere, which is the PRD's "no row shows a transcription status".
3. **The status lives on `meeting_files`, with a lease and a claim count of its own**, not in a
   second table. Every write is then one conditional statement that can also require the file to
   be `ready`, and an event still carries the whole file from one row. The file's own
   `leased_until` and `attempts` cannot be shared: the purge uses them, and a delete resets them.
4. **Transcription gets its own polling loop.** `MeetingFileWorker` handles one claim per tick,
   so a ten-minute transcription inside it would hold every other upload at `uploaded` — the
   opposite of "ready as soon as its checks pass". The second loop also bounds a replica to one
   transcription at a time. (`meeting-file-worker.ts` is 400 lines, so nothing is added to it
   either way.)
5. **Queueing is the pipeline's last step.** `TranscribeStep` becomes a step that only returns
   `transcriptionStatus: QUEUED` for an audio or video file while the setting is on. The worker
   already merges a step's patch into the `processing → ready` write, so "ready" and "queued" are
   one statement and one event, a file that fails never gets a status, a retried file gets one
   when it reaches `ready`, and a file processed while the setting was off never does.
6. **A graceful shutdown hands its claim back.** `TRANSCRIBING → QUEUED` with the claim count
   decremented, so no number of deploys can fail a recording. A crash still counts — the lease
   expires, the next claim increments — and the cap of three still bounds a recording that kills
   the process. This differs from the file worker on purpose: a transcription runs for minutes,
   so a deploy landing on one is expected rather than suspicious.
7. **A failure is fixed copy, decided by the worker.** One generic sentence, one that names the
   time limit, one for repeated attempts — exported from `@repo/shared` so the web app has the
   same fallback. The first provider error fails the transcription; there is no automatic retry.
8. **The Prisma enum is UPPER_CASE** (`.claude/rules/prisma.md`) **and the wire vocabulary is
   lower-case** like `MEETING_FILE_STATUSES`; `meeting-file.mapper.ts` is the one place that
   translates.

## Contract additions (`@repo/shared`)

```ts
export const MEETING_FILE_TRANSCRIPTION_STATUSES = [
  'queued',
  'transcribing',
  'transcribed',
  'failed',
] as const;

export interface MeetingFile {
  // …existing fields…
  /** Absent for a file that is not a recording, or that was never queued. */
  transcriptionStatus?: MeetingFileTranscriptionStatus;
  /** Present only when `transcriptionStatus` is `failed`. Safe to render. */
  transcriptionFailureReason?: string;
}
```

| Edge                           | Taken by                                               |
| ------------------------------ | ------------------------------------------------------ |
| _(none)_ → `queued`            | The file reaching `ready`, setting on, audio or video  |
| `queued` → `transcribing`      | A claim; also re-claims `transcribing` past its lease  |
| `transcribing` → `transcribed` | The transcript written, lease still held, file `ready` |
| `transcribing` → `failed`      | Provider error, time limit, or a fourth claim          |
| `transcribing` → `queued`      | Shutdown release                                       |
| `failed` → `queued`            | Retry (phase 4)                                        |

Phase 4 adds one route: `POST /api/meetings/:id/files/:fileId/transcription/retry` — uploader or
host, `200 MeetingFile`; anyone else `404 File not found`; not failed
`409 Only a failed transcription can be retried`.

## Implementation phases

### Phase 1: Whisper `small` runs locally (tracer bullet)

**Goal:** with one documented command and the existing flag, an uploaded recording is
transcribed by a Whisper `small` inside the deployment and its text is served by the existing
transcript route. Proves the riskiest part — the real server, real containers, real speed —
before any contract changes.
**Touches:** infrastructure, backend (configuration)

**Tasks:**

- [ ] `docker-compose.yml`: a `whisper` service under the `transcription` profile — the Speaches
      CPU image pinned to a release tag, `PRELOAD_MODELS=["Systran/faster-whisper-small"]`, the
      Hugging Face cache on a named volume, the port published on `127.0.0.1` only, a
      healthcheck. The `api` service passes the transcription variables through, defaulting the
      URL to the in-network address. Nothing depends on the service.
- [ ] Environment contract: `TRANSCRIPTION_MODEL` defaults to `Systran/faster-whisper-small` in
      `env.validation.ts` and `.env.example`, which also ships the local URL with the flag still
      `false`; the adapter's log line names the model it asked for. `env.validation.spec.ts`:
      the default model, flag off with no transcription variable present, and flag on with a
      well-formed URL nothing is listening on (boot checks the shape, never the server).
- [ ] Manual run against the real service, recorded in the commit body: a reference recording
      of a known sentence as MP3 and as MP4 returns that sentence from `GET …/transcript`; an
      M4A, a WAV, a WebM, and an M4V are each transcribed; an MP4 over 100 MB goes through the
      chunked upload; the model in use is `small`; and with outbound network blocked after the
      model is cached, the service restarts and transcribes again.
- [ ] Measure and set the time limit: time `small` on the Compose service against the reference
      recording and a long one, record seconds of work per minute of audio, and set
      `TRANSCRIPTION_TIMEOUT_SECONDS`'s default to cover a one-hour recording at twice that —
      in the class, `.env.example`, and Compose, with the measurement stated beside it.
- [ ] Documentation: `README.md` (Getting started: the command, the two settings, 0.5 GB to
      download, about 2 GB of memory, network needed on the first run only), the root guide
      (Setup; why it is a profile and `start:dev` does not start it), the API guide
      (Transcription and Environment).

**Done when:** on a fresh clone following the README, an MP3 and an MP4 upload each yield a
transcript containing the reference sentence, produced by `small`, including with the network
blocked; `pnpm format:check && pnpm lint && pnpm build && pnpm typecheck && pnpm test` pass, and
both `test:e2e` suites pass with the `whisper` service stopped.

### Phase 2: A transcription status of its own, in the API

**Goal:** a recording is `ready` and downloadable as soon as its checks pass, and the API
reports a separate transcription status that moves Queued → Transcribing → Transcribed or
Failed, over the list and the existing stream, surviving restarts and deletes.
**Touches:** database, backend

**Tasks:**

- [ ] Schema and contract: the `MeetingFileTranscriptionStatus` enum, `transcription_status`,
      `transcription_failure_reason`, `transcription_attempts`, `transcription_leased_until`,
      an index on status and lease, migration `add_meeting_file_transcription_status`; the
      shared vocabulary, fields, and failure copy; `MeetingFileRecord`, the mapper (reason only
      when failed), every new column in `claimNext`'s `RETURNING` list, and the e2e table
      helpers. Mapper spec.
- [ ] `QueueTranscriptionStep` replaces `TranscribeStep` as the pipeline's last entry;
      `StepPatch.transcriptKey` and the file worker's transcript discard go with it. Step spec:
      each of the six accepted recording types is queued, a PDF and a PNG are not, and nothing
      is with the setting off.
- [ ] `MeetingFileTranscriptionRepository` (a new class — the file repository is near the size
      limit): `claimNext` as one `FOR UPDATE SKIP LOCKED` statement over `ready` files that are
      queued or transcribing past their lease, `renewLease`, a conditional `transition` that
      also requires the file to be `ready` and the lease to match, and `release`. Spec for the
      edge table above.
- [ ] `MeetingFileTranscriptionWorker` with its own `PollingLoop`: idle while the setting is
      off; claim, heartbeat (the existing `startLeaseHeartbeat`, which now also aborts the
      request when the lease is lost), provider under the time limit, transcript written, then
      the conditional write; a lost race removes the transcript it wrote; shutdown releases; an
      event is published after every committed edge; `drain()` under a string token. Unit spec.
- [ ] E2E, red first, in new spec files (the existing ones are at the size limit). Flow: an MP3
      and a chunked MP4 are `ready` and downloadable while still queued, then transcribed, with
      each edge on the stream; a PDF and a PNG carry no status; a participant sees the same
      list and transcript and a stranger gets 404; of two recordings one fails and the other is
      untouched; a provider error, an undecodable file, and an exceeded limit each end Failed
      with the file `ready`, the limit named, and a marker string in the endpoint's error
      absent from the reason. Recovery: a shutdown release and an expired lease both end
      Transcribed; two concurrent claims take one row; a delete mid-run leaves no transcript and
      a 404; setting off — nothing queued, stored statuses still reported, a queued row
      untouched until it is back on, a file processed while off never queued.

**Done when:** those specs are green with every earlier e2e spec; a manual run against the real
service is recorded in the commit body — the API restarted mid-transcription, Whisper stopped
(Failed, file still downloadable), a truncated MP3; the CI commands pass; the API guide's
Transcription and claim-protocol sections describe the new contract and the superseded entries
are deleted; the root guide points at the PRD and this plan.

### Phase 3: The status on the meeting page

**Goal:** every viewer of a meeting sees each recording's transcription status change without
a reload and can open a finished transcript.
**Touches:** frontend

**Tasks:**

- [ ] Decompose `file-row.tsx` first (260 lines): move `Thumbnail` into its own file, a pure
      move with Vitest green before and after.
- [ ] `transcriptionPresentation` beside `statusPresentation` — nothing, queued, transcribing,
      transcribed, or failed with the shared fallback reason — and the fallback poll's condition
      widened to a queued or transcribing row, so a page without a stream still updates. Vitest
      tables for both.
- [ ] `fetchTranscript` in the API client and the row's transcription element: "Queued for
      transcription", "Transcribing…", an "Open transcript" link, "Transcription failed" with
      its reason. The transcript is fetched with the bearer header and opened from an object
      URL in a tab opened inside the click, so a popup blocker does not swallow it; a 401 signs
      out, any other error shows inline. Vitest for the client call.
- [ ] A transcriber for the browser suite: a small OpenAI-shaped fake started by Playwright's
      `webServer`, which a spec can tell to hold, fail, or answer; `start:e2e-web` turns
      transcription on and points at it. No spec depends on a running Whisper.
- [ ] Playwright spec `meeting-files-transcription.spec.ts`: an uploaded MP3 can be downloaded
      while its row says Queued, then Transcribing, then offers "Open transcript", with no
      reload, and the link shows the fake's sentence; a PDF and a PNG show nothing; a second
      participant sees the same row and opens the same text; a failing recording shows the
      reason while its neighbour finishes; deleting a row that is Transcribing removes it.

**Done when:** the spec is green with the existing browser suite; Vitest is green; browser
inspection in both themes, and one run against the real service with the API restarted
mid-transcription, are recorded in the commit body; the CI commands pass; the web guide's
meeting-page section covers the status, the object-URL link, and the poll condition.

### Phase 4: Retrying a failed transcription, in the API

**Goal:** one request sends a failed transcription back to the queue.
**Touches:** backend

**Tasks:**

- [ ] `RetryMeetingFileTranscriptionCommand` and its handler: visible meeting (404), non-deleted
      file (404), uploader or host (404), then the conditional `failed → queued` that resets the
      claim count and clears the reason (409 on zero rows); publishes the event and returns the
      file as written. Unit spec for the four outcomes.
- [ ] `POST :fileId/transcription/retry` on `MeetingFilesController`, and the handler in the
      module's `providers`.
- [ ] E2E spec `meeting-files-transcription-retry.e2e-spec.ts`, red first: the uploader's retry
      ends Transcribed after a drain; the host's does too; another participant and a stranger
      get 404; a transcription that is not failed gets 409; the claim count is 0 in the table;
      the stream carries the edge.

**Done when:** the spec is green with every earlier e2e spec; the CI commands pass; the API
guide names the route as the one caller of `failed → queued`.

### Phase 5: Retry on the meeting page

**Goal:** the uploader or the host recovers a failed transcription from the row.
**Touches:** frontend

**Tasks:**

- [ ] `retryMeetingFileTranscription` in the API client, with Vitest.
- [ ] A Retry action on a failed transcription, shown under the existing `canManage` flag only;
      a 409 refetches the list, any other error shows inline with Dismiss, as the file retry
      does.
- [ ] Playwright spec, extending phase 3's fake: a failed recording shows Retry to its uploader
      and to the host and not to another participant; with the fake answering again, Retry
      takes the row to Queued and then to "Open transcript", and Download works throughout.

**Done when:** the spec is green with the whole browser suite; a run against the real service
is recorded in the commit body — Whisper stopped, upload, Failed, Whisper started, Retry,
Transcribed; browser inspection in both themes; the CI commands pass; the web guide says the
action shares Delete's gate.

## Acceptance criteria, by phase

| PRD criterion                                                                   | Phase |
| ------------------------------------------------------------------------------- | ----- |
| MP3: `ready` before transcribed; Queued → Transcribing → Transcribed, no reload | 2, 3  |
| MP4, direct and chunked                                                         | 1, 2  |
| M4A, WAV, WebM, M4V reach Transcribed                                           | 1, 2  |
| "Open transcript" shows the reference sentence                                  | 1, 3  |
| PDF and PNG show no status and behave as before                                 | 2, 3  |
| Second participant sees and opens; a stranger gets 404                          | 2, 3  |
| Two recordings, independent statuses                                            | 2, 3  |
| Whisper stopped: file `ready`, transcription Failed, Download works             | 2, 3  |
| Retry by uploader and host; no control and a 404 for others                     | 4, 5  |
| Undecodable recording ends Failed, file `ready`                                 | 2     |
| Time limit exceeded ends Failed, limit named                                    | 1, 2  |
| Reason never contains Whisper's raw error text                                  | 2     |
| API restart while Transcribing                                                  | 2, 3  |
| Delete while Transcribing                                                       | 2, 3  |
| Transcribes with outbound network blocked                                       | 1     |
| Documented set-up uses `small` with no setting changed                          | 1     |
| Switched off: no status, `ready` as today, boots with no Whisper setting        | 1, 2  |
| Switched on, Whisper not running: boots, uploads and downloads work             | 1, 2  |
| Uploaded while off: no status after switching on                                | 2     |
| README, guides, and `.env.example`                                              | 1–5   |
| CI commands and both e2e suites with no Whisper running                         | 1–5   |
