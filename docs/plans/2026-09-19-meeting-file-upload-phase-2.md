# Meeting File Upload — Phase 2 Implementation Plan

**PRD:** [`docs/specs/2026-09-19-meeting-file-upload-prd.md`](../specs/2026-09-19-meeting-file-upload-prd.md) — _Phasing_, row 2: "Chunked, resumable upload through the API for files over the cap."
**Date:** 2026-09-19
**Depends on:** the [Phase 1 plan](2026-09-19-meeting-file-upload-phase-1.md) landed in full. Independent of Phases 3 and 4.

**Goal:** A recording larger than the single-request cap reaches the meeting through the same API, in chunks, and survives a dropped connection or a page reload without starting over. Once the last chunk lands, the file is an ordinary `MeetingFile` and goes through the Phase 1 pipeline unchanged.

**Method:** the Phase 1 _Test-first protocol_ applies unchanged — every task's e2e spec is written and run red first, and every earlier e2e spec stays green and unmodified. The Phase 1 _Global Constraints_ apply too (contract values in `@repo/shared`, `meeting-files` never imports `MeetingsModule`, 404 never 403, docs in the same commit, Conventional Commits).

## Assumptions the PRD does not settle

These are defaults so the plan can be executed. Each is one line to change if product decides otherwise; confirm them before Phase 2.1 starts.

1. **Chunked cap: 1 GiB** (`MAX_CHUNKED_MEETING_FILE_SIZE_BYTES = 1024 ** 3`). The PRD's `size Int` column holds values up to 2 GiB minus one byte; 1 GiB keeps the column as it is. Raising the cap past 2 GiB is the `BigInt` change the PRD's _Data model_ section describes and is not in this plan.
2. **Chunk size: 8 MiB**, fixed by the server and returned when a session is created. The client never chooses it.
3. **The single-request route stays.** `POST /api/meetings/:id/files` and its 100 MB cap are unchanged. The web app uses the chunked path only for files over that cap, so Phase 1's behaviour for small files does not change and its specs stay green.
4. **A session lives 24 hours** from creation (`MEETING_FILE_UPLOAD_TTL_HOURS`, default `24`). The worker removes expired sessions and their chunks through the same purge path it uses for deleted files.
5. **Resume across a page reload needs the user to pick the file again.** A browser cannot keep a `File` handle across reloads. The client remembers the session id under a fingerprint (name, size, last-modified) and, when the same file is picked again, asks the server which chunks it already has and sends only the rest.

## Design constraints

- **F1 still holds: no `MeetingFile` record exists until the bytes are complete.** A session is its own table, `meeting_file_uploads`, and it is never listed with the meeting's files. Completing a session is the only thing that creates a `MeetingFile`, and it does so with the same sniff → `fsync` → rename → transaction sequence Phase 1's upload handler uses (design decision 7), so the cap on file count and the visibility rule are enforced in one place.
- **Chunks are stored under `<MEETING_FILES_DIR>/uploads/<uploadId>/<index>`** through `MeetingFileStorage`, whose key regex gains a second branch for this layout. Nothing else in the module touches `fs`.
- **Assembly is a stream, not a buffer.** Completion concatenates the chunk files into `<root>/tmp/<uploadId>` with `pipeline()` and then hands that path to the existing upload command, so a 1 GiB file never sits in memory.
- **Sniffing happens at completion**, on the assembled file, exactly as for a single-request upload. A session's declared name is validated at creation with `normaliseFileName`; the type is never trusted from the client.
- **The web client uses `XMLHttpRequest` per chunk**, through the one wrapper in `api-client.ts`, so per-chunk progress and `AbortSignal` work the way Phase 1's single-request upload does.

## Contract additions (`@repo/shared`)

```ts
export const MAX_CHUNKED_MEETING_FILE_SIZE_BYTES = 1024 ** 3;
export const MEETING_FILE_CHUNK_SIZE_BYTES = 8 * 1024 * 1024;

export interface MeetingFileUpload {
  id: string;
  meetingId: Meeting['id'];
  name: string;
  size: number;
  chunkSize: number;
  chunkCount: number;
  /** Indexes the server has durably stored, ascending. */
  receivedChunks: ReadonlyArray<number>;
  /** ISO 8601 instants, UTC. */
  createdAt: string;
  expiresAt: string;
}
```

## Routes

| Method   | Path                                                  | Who                 | Result                                                    |
| -------- | ----------------------------------------------------- | ------------------- | --------------------------------------------------------- |
| `POST`   | `/api/meetings/:id/files/uploads`                     | host or participant | `201 MeetingFileUpload` for `{ name, size }`              |
| `GET`    | `/api/meetings/:id/files/uploads/:uploadId`           | the session's owner | `200 MeetingFileUpload` with the current `receivedChunks` |
| `PUT`    | `/api/meetings/:id/files/uploads/:uploadId/chunks/:n` | the session's owner | `204`; raw body, `Content-Length` required                |
| `POST`   | `/api/meetings/:id/files/uploads/:uploadId/complete`  | the session's owner | `201 MeetingFile` with status `uploaded`                  |
| `DELETE` | `/api/meetings/:id/files/uploads/:uploadId`           | the session's owner | `204`; chunks removed by the worker                       |

Rejections, each pinned in an e2e spec with its exact message:

| Case                                      | Status | Message                                                          |
| ----------------------------------------- | ------ | ---------------------------------------------------------------- |
| `size` ≤ 0 or not an integer              | 400    | `The file size must be a positive number of bytes`               |
| `size` > chunked cap                      | 413    | `Files must be 1 GB or smaller.`                                 |
| Bad name                                  | 400    | Phase 1's name message                                           |
| Meeting already at the count cap          | 409    | `This meeting already has 50 files.` (checked again on complete) |
| Chunk index out of range                  | 400    | `Chunk index out of range`                                       |
| Chunk body length wrong for its index     | 400    | `Chunk length does not match`                                    |
| Complete with chunks missing              | 409    | `The upload is incomplete`                                       |
| Completed file fails the type check       | 415    | `That file type is not supported.`                               |
| Session expired, or owned by someone else | 404    | `Upload not found`                                               |
| Meeting not visible                       | 404    | `Meeting not found`                                              |

A chunk sent twice with the same bytes is accepted and idempotent. A chunk sent twice with different bytes overwrites the first; the checksum computed by the Verify step is what guarantees the assembled file is what the client meant to send.

## Implementation phases

### Phase 2.1: Upload sessions and chunk storage

**Goal:** the API can open a session, accept every chunk of a large file, and report which chunks it has. Nothing is assembled yet, but the whole write path is exercised and durable, and the session survives an API restart.
**Touches:** database, backend

**Tasks:**

- [ ] Add the contract: `MAX_CHUNKED_MEETING_FILE_SIZE_BYTES`, `MEETING_FILE_CHUNK_SIZE_BYTES`, and `MeetingFileUpload` in `packages/shared`, exported from `src/index.ts`; restate the two numbers in `apps/api/test/utils/fixtures.ts` as Phase 1 did for the single-request caps.
- [ ] Add the `MeetingFileUpload` model (`meeting_file_uploads`: id, meeting id, uploader id, name, size, chunk size, chunk count, `received_chunks int[]`, `created_at`, `expires_at`, `purged_at`) with `onDelete: Restrict` on both relations and an index on `(expires_at, purged_at)`; migration `add_meeting_file_uploads`; raw-SQL test helper `test/utils/meeting-file-uploads-table.ts` in the style of the Phase 1 helpers.
- [ ] Extend `MeetingFileStorage` with the `uploads/<uploadId>/<index>` key branch, `putChunk(key, sourcePath)`, and `removeTree(uploadId)`; unit spec for the new key validation (a traversal attempt in either segment throws before touching `fs`).
- [ ] `CreateUploadCommand` and `StoreChunkCommand` with handlers, `MeetingFileUploadsService.findOne` for the status read, and the `POST`, `PUT`, and `GET` routes on a new `MeetingFileUploadsController` under the same guard and `ParseUUIDPipe` as Phase 1. The `PUT` body is raw (`express.raw` with a limit of one chunk); the handler `fsync`s the chunk before the row's `received_chunks` is updated, so a chunk the server has acknowledged is on disk.
- [ ] E2E spec `test/meeting-file-uploads.e2e-spec.ts`, written red first: create → 201 with the expected chunk count; every rejection in the table above that applies to these three routes; a participant may create a session and a stranger gets 404; the owner sees `receivedChunks` grow as chunks land, out of order; the same chunk sent twice leaves one entry; a second user cannot read or write another user's session (404); chunks are on disk under the expected keys with the expected bytes.

**Done when:** the e2e spec above is green, every Phase 1 e2e spec is green and unmodified, and a session created before `app.close()` reports the same `receivedChunks` after the app is booted again in the same test.

### Phase 2.2: Completion, abort, and expiry

**Goal:** a complete session becomes a `MeetingFile` and enters the Phase 1 pipeline; an abandoned session costs nothing after its TTL. After this phase the whole large-file path works end to end from `curl`.
**Touches:** backend

**Tasks:**

- [ ] `CompleteUploadCommand` and handler: verify every chunk is present, stream-concatenate into `<root>/tmp/<uploadId>`, then invoke Phase 1's `UploadMeetingFileCommand` with that path. On success mark the session `purged_at = now()` only after its chunk tree is removed; on any failure leave the session intact so the client can retry `complete` without re-sending chunks. A `MeetingFile` created this way is indistinguishable from a single-request upload.
- [ ] `AbortUploadCommand` and the `DELETE` route: set `expires_at = now()` so the worker's next tick purges it. Deleting twice is 404.
- [ ] Worker: the claim query gains expired, unpurged sessions as a third kind of row (`removeTree(uploadId)` then `purged_at`), using the same lease so a crash mid-removal is retried. `drain()` counts them.
- [ ] Env: `MEETING_FILE_UPLOAD_TTL_HOURS` (default `24`, `@Min(1)`) in `env.validation.ts` + spec, `.env.example`, and `turbo.json` if `pnpm dev` must pass it through.
- [ ] E2E specs, red first: extend `meeting-file-uploads.e2e-spec.ts` with completion (the `MeetingFile` row exists with the assembled size, the object's SHA-256 equals the original's, the session is purged, `tmp/` is empty, and `drain()` moves the file to `ready` with a checksum), completion with a missing chunk (409, nothing created), completion of an HTML file named `.pdf` (415 and the session still there), completion when the meeting hit the count cap between create and complete (409), abort, and expiry (set `expires_at` in the past via SQL → `drain()` → chunk directory gone, `purged_at` set). Unit specs for the completion handler's failure ordering and the worker's new row kind.

**Done when:** a 1 GiB sparse file uploaded in chunks with `curl` from a shell script in the commit body appears in the meeting, downloads byte-identical, and shows a checksum; the two e2e files are green together with every Phase 1 spec; `pnpm build && pnpm typecheck && pnpm test` pass.

### Phase 2.3: Chunked upload in the web app

**Goal:** a user picks or drops a file over 100 MB on the meeting page and it uploads in chunks with a percentage, can be cancelled, resumes after a dropped connection, and resumes after a reload once the same file is picked again.
**Touches:** frontend

**Tasks:**

- [ ] `api-client.ts`: `createUpload`, `getUpload`, `putChunk` (XHR, progress, `AbortSignal`), `completeUpload`, `abortUpload`, each tested with the Phase 1 fake `XMLHttpRequest` or `fetch`.
- [ ] `src/lib/chunked-upload.ts`: a pure `planChunks(size, chunkSize)`, `fingerprint(file)`, and `uploadInChunks(token, meetingId, file, { signal, onProgress, resumeFrom? })` that sends missing chunks sequentially, retries a chunk up to three times on a network error before surfacing it, and calls `complete`. Progress is bytes acknowledged over total. Unit-tested with a fake transport, including the resume path and the retry cap.
- [ ] `validateFileBeforeUpload` raises its size limit to the chunked cap with the message `Files must be 1 GB or smaller.`; `useMeetingFiles`'s queue routes a file over 100 MB to `uploadInChunks` and everything else to the Phase 1 path. Cancel calls `abortUpload`. The session id is stored in `localStorage` under the fingerprint and cleared on completion or abort.
- [ ] `UploadRow` shows the percentage from chunk progress, a "Resuming…" state when a stored session is found for a re-picked file, and the server's message on failure with Retry (re-runs `uploadInChunks` with the same session) and Dismiss.
- [ ] Playwright spec `apps/web/e2e/meeting-files-chunked.spec.ts`, red first: a 150 MB sparse file generated at suite start uploads with a progress percentage and lands in the list as Processing; the network is taken offline mid-upload (`context.setOffline(true)`) and restored, and the upload finishes without re-sending acknowledged chunks (count `PUT` requests per index); reload mid-upload, pick the same file again, and the row shows "Resuming…" then completes with fewer `PUT`s than chunks; Cancel removes the row and issues a `DELETE`; a 1.1 GB file is rejected client-side with the new size message and no request is made.

**Done when:** the Playwright spec is green alongside the Phase 1 browser suite; the Vitest suite is green; the web guide's "API access" section documents the chunked path and the `localStorage` session key; browser inspection in both themes and at a narrow viewport is recorded in the commit body.

## Documentation owed

- Root guide and `README.md`: the chunked cap next to the single-request cap in the setup notes, and `MEETING_FILE_UPLOAD_TTL_HOURS`.
- API guide: the `meeting_file_uploads` table and why it is not a `MeetingFile`, the stream assembly, the third claim-row kind, and the storage key layout.
- Web guide: which uploads are chunked, the fingerprint key, and the resume-needs-a-re-pick constraint.

## Out of scope

- Parallel chunk uploads. Sequential is simpler and the bottleneck is the user's uplink.
- Raising the cap past 2 GiB (`size` to `BigInt`).
- Transcoding, transcription, or any pipeline change — the completed file enters Phase 1's pipeline as is.
