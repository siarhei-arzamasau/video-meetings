# PRD — Meeting file upload, storage, and processing

**Date:** 2026-09-19
**Status:** draft
**Builds on:**
[`2026-07-29-video-meetings-monorepo-design.md`](2026-07-29-video-meetings-monorepo-design.md)
(meetings API and web shell),
[`2026-07-30-auth-user-module-split-design.md`](2026-07-30-auth-user-module-split-design.md)
(module boundaries over the CQRS buses)

## Summary

A signed-in user can attach files to a meeting they host or attend. The file is stored
durably, processed asynchronously, and listed inside the meeting with its processing state,
so anyone in the meeting can see what was shared, download it, and know whether it is ready.

This document is the product requirement. A dated design spec will follow it with the module
layout, the storage service, and the processing worker; this PRD fixes _what_ is built and
_why_, and the constraints any design must satisfy.

## Problem

A meeting today is a title, a time, a host, and a participant list. There is nowhere to put
the agenda, the deck, the recording, or the notes that a meeting produces. Users keep those
in chat threads and mail, disconnected from the meeting they belong to, and nothing can be
processed on the platform's behalf — no transcript, no preview, no search — because the
platform never holds the bytes.

Two things are missing, and they are one feature:

1. **Storage** — a file lives with the meeting, visible to the people in it and nobody else.
2. **Processing** — once stored, a file goes through a pipeline the platform owns, and the
   meeting shows the outcome. The first pipeline is deliberately small (see _Scope_), but
   the state machine and the UI are built for the pipelines that follow.

## Goals

- A host or participant can upload a file to a meeting from the meeting page, in the browser.
- Every file in a meeting is listed on that meeting's page with name, size, uploader, upload
  time, and processing status, and can be downloaded by anyone who can see the meeting.
- Processing is asynchronous and durable: an upload is acknowledged the moment the bytes are
  stored, and its status advances afterwards without the user waiting on the request.
- Access follows meeting visibility exactly. If you cannot see the meeting, you cannot see,
  fetch, or learn the existence of its files.
- The web app gets a meeting detail page. None exists yet, and "inside the meeting" needs one.

## Non-goals

- **Transcription, summarisation, or any AI processing.** The pipeline is designed for
  them; this PRD ships none of them.
- **Resumable or chunked uploads, and files over the v1 size cap.** Recordings of long
  meetings will exceed it; see _Phasing_ for the chunked-upload step.
- **In-meeting live sharing.** Files are attached to the meeting record; nothing in this PRD
  reaches a call in progress.
- **Sharing outside the meeting.** No public links, no cross-meeting file library.
- **Editing files in place, versioning, or folders.**
- **Quotas and billing.** Limits in v1 are per-file and per-meeting caps, not per-account
  storage accounting.

## Users and stories

The platform has one kind of account. Within a meeting a user is either its **host** or a
**participant**; anyone else cannot see the meeting and is out of scope for every story.

| As a…       | I want to…                                                | So that…                                              |
| ----------- | --------------------------------------------------------- | ----------------------------------------------------- |
| host        | upload an agenda or deck before the meeting               | attendees find it in one place                        |
| participant | upload notes or a recording after the meeting             | the meeting record is complete                        |
| either      | see every file in the meeting, with who added it and when | I know what is there without asking                   |
| either      | see whether a file is still processing, ready, or failed  | I do not download something half-done or wait forever |
| either      | download any file in the meeting                          | I can use it                                          |
| uploader    | delete a file I uploaded                                  | I can fix a mistaken upload                           |
| host        | delete any file in my meeting                             | I can curate what the meeting holds                   |

## Requirements

### Functional

**F1. Upload.** `POST /api/meetings/:id/files` accepts one file per request as `multipart/form-data`,
from the host or a participant of that meeting. The response is the created file record
(shape in _Contract_) with status `uploaded`. The request succeeds only once the bytes are
durably stored; a storage failure fails the request and writes no record.

**F2. Validation.** The API rejects, with the standard `ApiErrorResponse` and a message the UI
can show verbatim:

| Rule       | Limit                                                     | Response |
| ---------- | --------------------------------------------------------- | -------- |
| Size       | 100 MB per file                                           | 413      |
| Count      | 50 files per meeting                                      | 409      |
| Type       | allow-list (below); server-sniffed, never client-claimed  | 415      |
| Empty file | 0 bytes                                                   | 400      |
| Name       | 1–255 characters after trimming; path separators rejected | 400      |

The v1 allow-list: PDF, PNG, JPEG, GIF, WebP, MP4, WebM, MP3, M4A, WAV, plain text,
Markdown, CSV, and the Office formats DOCX, XLSX, PPTX. The list lives in `@repo/shared` so
the picker's `accept` attribute and the server's check cannot disagree. Sniffing is by
content, and the sniffed type is what the record stores; the browser's `Content-Type` is
advisory only.

**F3. Listing.** `GET /api/meetings/:id/files` returns every file of the meeting, newest first
with `id` as a tie-break, to the host or a participant. `GET /api/meetings/:id` is unchanged;
files are a separate resource so the meeting list on the home page does not grow a join.

**F4. Download.** `GET /api/meetings/:id/files/:fileId/content` streams the bytes with the
stored content type, a `Content-Disposition: attachment` header carrying the original name,
and `Content-Length`. Available in any status except `deleted`; the UI decides whether to
offer it (see UX). Because the token lives in `localStorage` and cannot ride on a plain
`<a href>`, the web app fetches with the bearer header and hands the blob to the browser.

**F5. Delete.** `DELETE /api/meetings/:id/files/:fileId` by the uploader or the host. Deletion
is soft in the record (status `deleted`, `deletedAt` set) and eventual in storage: the object
is removed by the processing worker, so a storage hiccup cannot leave a record pointing at
bytes that are still there. Deleted files are omitted from listings. Anyone else gets 404,
not 403, for the same reason the meetings API does.

**F6. Visibility.** Every route above resolves the meeting with the same `visibleTo` rule the
meetings module already uses, and answers 404 for a meeting the caller cannot see, before
touching the file. A file id from another meeting is 404, not 403.

**F7. Processing state machine.** Each file has exactly one status:

```
uploaded ──▶ processing ──▶ ready
                 │
                 └────────▶ failed
       (any of the above) ──▶ deleted
```

- `uploaded`: bytes stored, record written, no worker has picked it up.
- `processing`: a worker owns it. A worker that dies mid-file must not strand it: a file in
  `processing` longer than a bounded lease is retried.
- `ready`: every step of the pipeline succeeded. `processedAt` is set.
- `failed`: a step failed after its retries. `failureReason` holds a message safe to show a
  user (never a stack trace). Failed files stay downloadable; failing to process a file is
  not the same as losing it.
- `deleted`: terminal.

Transitions are recorded with timestamps. A file never moves backwards except by an explicit
retry (out of scope for v1 UI; the state machine allows `failed → uploaded`).

**F8. The v1 pipeline.** Two steps, both cheap, both required for the state machine to be
observable end to end:

1. **Verify** — re-read the stored object, confirm its size matches the record and compute
   a SHA-256 checksum, stored on the record. Catches a truncated write.
2. **Preview** — for images, a bounded-size thumbnail stored beside the original and served
   from `GET …/files/:fileId/thumbnail`. For every other type, no-op success.

The pipeline is a list of steps; adding a step must not touch the state machine or the API.

**F9. Durability of processing.** Processing state lives in PostgreSQL, not in memory. An API
restart loses no queued work. No new infrastructure (Redis, a queue service) is required for
v1; the design spec decides between a polling worker inside the API process and a separate
process, and must justify the choice against `pnpm dev` running one API process.

**F10. Storage backend.** Files live on the local filesystem of the API process, under one
root directory set by `MEETING_FILES_DIR`. There is no object storage and no cloud adapter:
the platform runs as a single API instance, and a disk it owns is the simplest thing that
holds a file durably. The storage code is still one service with a narrow interface (put,
open as a stream, stat, remove) so the rest of the module never touches `fs` directly and a
different backend later is one class, not a rewrite.

Paths under the root are opaque (`<meetingId>/<fileId>`), never the user's filename, so a name
can never become a path. The root is created at boot if missing and its writability is checked
then, not at the first upload. In `docker compose`, the API service mounts a named volume at
that root so a rebuilt container keeps its files. Backups of the directory are an operational
concern outside this PRD, and the design spec must say so in the API guide.

**F11. Meeting deletion.** Meetings cannot be deleted today. When they can, files cascade
through the same soft-delete-then-worker path, not a database cascade that orphans objects.

### Non-functional

- **Latency.** Upload of a 10 MB file on a local network acknowledges within 2 s of the last
  byte. Listing is one indexed query.
- **Concurrency.** Two uploads to the same meeting at once both succeed or the second fails
  the count cap cleanly; the cap is enforced in a transaction, not by a read-then-write.
- **Security.** Bytes are served only through the API, with the same JWT guard as every other
  route. The API never trusts a client-supplied content type or filename in a header without
  sanitising it. The download endpoint sets `X-Content-Type-Options: nosniff`. HTML and SVG are
  not on the allow-list because a stored one served inline is a stored XSS.
- **Observability.** Each transition logs `fileId`, `meetingId`, from-status, to-status, and
  duration. A failed step logs the cause at `error`; the record stores only the user-safe
  reason.
- **Configuration.** `MEETING_FILES_DIR` is an environment variable, validated at boot in
  `env.validation.ts` (non-empty, and the directory writable), documented in
  `apps/api/.env.example`, and declared in `turbo.json` if `pnpm dev` must pass it through.
  The development default is a gitignored `apps/api/storage/` directory; tests use a
  temporary directory created per run and removed afterwards, so `test:e2e` never reads or
  deletes real uploads.
- **Tests.** Unit specs for the DTO, the mapper, and the state machine. An e2e spec, against
  a temporary storage directory, covering: upload → list → download round trip, every rejection in
  F2, visibility (a non-member gets 404 for every route), delete by uploader, delete by host,
  delete by another participant refused, and the worker moving a file to `ready`.

## Contract (`@repo/shared`)

```ts
export const MEETING_FILE_STATUSES = [
  'uploaded',
  'processing',
  'ready',
  'failed',
  'deleted',
] as const;
export type MeetingFileStatus = (typeof MEETING_FILE_STATUSES)[number];

export interface MeetingFile {
  id: string;
  meetingId: Meeting['id'];
  uploaderId: User['id'];
  /** The user's filename after trimming and separator rejection. Display only; never a path. */
  name: string;
  /** Server-sniffed media type. */
  contentType: string;
  /** Bytes. */
  size: number;
  status: MeetingFileStatus;
  /** Present only when `status` is `failed`. Safe to render. */
  failureReason?: string;
  /** Present when a thumbnail exists; a relative API path. */
  thumbnailPath?: string;
  /** ISO 8601 instants, UTC. */
  createdAt: string;
  processedAt?: string;
}

export const MAX_MEETING_FILE_SIZE_BYTES = 100 * 1024 * 1024;
export const MAX_MEETING_FILES = 50;
export const MEETING_FILE_ALLOWED_TYPES: ReadonlyArray<string>;
```

The limits and the allow-list are values, not documentation, for the reason the root guide
gives: a rule the client restates is a rule that will one day disagree with the server.

## UX

### Meeting page (new)

Route `/meetings/[id]`, client-gated exactly like `/` (token read after mount, 401 clears the
token and redirects). The home page's meeting cards become links to it.

Layout, top to bottom:

1. **Header** — title, status chip, scheduled time, host, participant count. Back link to `/`.
2. **Files** — the section this PRD adds. Rendered below the header; it is the page's
   main content until the meeting page grows other sections.

### Files section

- **Upload control.** A HeroUI `Button` labelled "Add file" that opens the native picker
  with `accept` derived from the shared allow-list, plus the section as a drop target. Drop
  and pick go through the same handler. Multiple selections upload sequentially, one request
  each, so one rejection does not lose the rest.
- **In-flight row.** Each upload appears immediately as a row with an indeterminate progress
  indicator and a Cancel action (aborts the request; nothing to clean up server-side because
  the record is written only after the bytes land). Progress is per-file; a percentage is
  shown when the browser reports it.
- **List.** One row per file, newest first: type icon or thumbnail, name, size, "added by
  _name_ · _relative time_", status chip, actions. Empty state: "No files yet" with the same
  "Add file" button.
- **Status chips.** `uploaded` and `processing` render as one "Processing" chip; the
  difference is the worker's, not the user's. `ready` renders no chip (ready is the default
  state, and a chip on every row is noise). `failed` renders a warning chip with the
  `failureReason` in a tooltip.
- **Actions.** Download always. Delete when the viewer is the uploader or the host, behind a
  confirm dialog naming the file.
- **Freshness.** While any file is `uploaded` or `processing`, the list refetches every 3 s
  and stops when none is. No websocket in v1.
- **Errors.** A rejected upload shows the API's message inline on that row, with Dismiss.
  A failed list load uses the same `Alert` + "Try again" pattern as the home page.

### Copy

| Context                 | Text                                                           |
| ----------------------- | -------------------------------------------------------------- |
| Empty section           | No files yet. Add an agenda, a deck, or a recording.           |
| Over size cap (client)  | Files must be 100 MB or smaller.                               |
| Over count cap (server) | This meeting already has 50 files.                             |
| Type rejected           | That file type is not supported.                               |
| Delete confirm          | Delete "_name_"? People in this meeting will no longer see it. |
| Processing failed       | Processing failed. You can still download the file.            |

The client checks size and type before sending, to save the round trip, and still renders the
server's message if the server disagrees.

## Data model

```prisma
enum MeetingFileStatus { uploaded processing ready failed deleted  @@map("meeting_file_status") }

model MeetingFile {
  id            String            @id @default(uuid()) @db.Uuid
  meetingId     String            @map("meeting_id") @db.Uuid
  uploaderId    String            @map("uploader_id") @db.Uuid
  name          String
  contentType   String            @map("content_type")
  size          Int
  storageKey    String            @unique @map("storage_key")
  checksum      String?
  thumbnailKey  String?           @map("thumbnail_key")
  status        MeetingFileStatus @default(uploaded)
  failureReason String?           @map("failure_reason")
  attempts      Int               @default(0)
  leasedUntil   DateTime?         @map("leased_until") @db.Timestamptz(3)
  createdAt     DateTime          @default(now()) @map("created_at") @db.Timestamptz(3)
  processedAt   DateTime?         @map("processed_at") @db.Timestamptz(3)
  deletedAt     DateTime?         @map("deleted_at") @db.Timestamptz(3)

  meeting  Meeting @relation(fields: [meetingId], references: [id], onDelete: Restrict)
  uploader User    @relation(fields: [uploaderId], references: [id], onDelete: Restrict)

  @@index([meetingId, status])
  @@index([status, leasedUntil])
  @@map("meeting_files")
}
```

`onDelete: Restrict` on both relations is deliberate (F11): nothing may delete a meeting or a
user from under a file without going through the worker. `size` is `Int` because the cap is
100 MB; if the cap ever exceeds 2 GB the column becomes `BigInt` in the same change.

## Module shape (constraint on the design spec)

A new `src/modules/meeting-files` module, CQRS like the others: `UploadMeetingFileCommand`
and `DeleteMeetingFileCommand` with handlers; reads on a plain `MeetingFilesService`. It does
**not** import `MeetingsModule`. Visibility is resolved by dispatching a query the meetings
module answers (`FindVisibleMeetingQuery(userId, meetingId) → Meeting | null`), which is the
first read to cross out of `meetings` and therefore the first justified `QueryBus` use there,
by the rule the user-module split established.

The storage service and the processing worker are their own providers inside the module;
the design spec decides their file layout.

## Success metrics

Measured over the first four weeks after release:

- At least 30% of meetings that reach `ended` have at least one file.
- 99% of files reach `ready` within 60 s of upload (p99, from `createdAt` to `processedAt`).
- Under 1% of uploads end `failed`. Every `failed` has a `failureReason` that is not the
  generic fallback.
- Zero files ever served to a user who is not the host or a participant of the meeting. This
  one is a test, not a dashboard.

## Phasing

| Phase | Delivers                                                                                |
| ----- | --------------------------------------------------------------------------------------- |
| 1     | Everything in _Requirements_ and _UX_ above. Local-disk storage. Verify + Preview.      |
| 2     | Chunked, resumable upload through the API for files over the cap.                       |
| 3     | Retry from the UI for `failed`; a transcription step for audio and video behind a flag. |
| 4     | Server-sent progress replacing the 3 s poll.                                            |

Phase 1 is the commitment; the rest is direction, listed so the state machine and the API
are not designed in a way that forecloses them.

## Open questions

1. **Worker placement.** In-process polling worker (zero new infra, but every API replica
   polls) versus a separate `worker` entry point in `apps/api` (one more process in
   `pnpm dev`). Recommendation: in-process behind a `MEETING_FILES_WORKER_ENABLED` flag,
   defaulting on, so a deployment can run it on one replica. To be settled in the design spec.
2. **Thumbnail library.** `sharp` needs an `allowBuilds` entry in `pnpm-workspace.yaml`; a
   pure-JS alternative avoids that at a quality cost. Recommendation: `sharp`.
3. **Should participants delete their own files after the meeting has `ended`?** This PRD
   says yes; product may want the host to own the record once the meeting is over.
4. **Download for `uploaded`/`processing`.** Allowed here because the bytes are complete.
   If a future step rewrites the object (transcoding), this must become "ready only".

## Acceptance criteria

- [ ] A participant uploads a 5 MB PDF from `/meetings/[id]`; it appears in the list within
      the same interaction, shows "Processing", and shows no chip within 10 s.
- [ ] A 101 MB file is rejected client-side with the size message and never sent.
- [ ] A `.html` file renamed to `.pdf` is rejected by the server with 415.
- [ ] The 51st upload to a meeting is rejected with 409 and the count message.
- [ ] A signed-in user who is neither host nor participant gets 404 from every file route,
      including download by a guessed id.
- [ ] The uploader and the host see Delete; another participant does not, and the API refuses
      them with 404.
- [ ] Killing the API while a file is `processing` and restarting it results in `ready`
      without user action.
- [ ] Downloading a `failed` file returns the original bytes.
- [ ] `pnpm build`, `pnpm typecheck`, `pnpm test`, and `pnpm --filter=@repo/api test:e2e`
      pass, in that order, on the finished tree.
