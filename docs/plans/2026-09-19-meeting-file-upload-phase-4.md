# Meeting File Upload — Phase 4 Implementation Plan

**PRD:** [`docs/specs/2026-09-19-meeting-file-upload-prd.md`](../specs/2026-09-19-meeting-file-upload-prd.md) — _Phasing_, row 4: "Server-sent progress replacing the 3 s poll."
**Date:** 2026-09-19
**Depends on:** the [Phase 1 plan](2026-09-19-meeting-file-upload-phase-1.md) landed in full. Independent of Phases 2 and 3; if Phase 3 has landed, retry and transcript changes flow through the same stream with no extra work.

**Goal:** the meeting page learns about a file's status change the moment the worker records it, instead of asking every 3 seconds. The poll stays as the fallback when a stream cannot be opened, so nothing a user can see gets worse.

**Method:** the Phase 1 _Test-first protocol_ and _Global Constraints_ apply unchanged.

## Assumptions the PRD does not settle

1. **Transport: Server-Sent Events over `fetch`, not `EventSource`.** The token lives in `localStorage` and `EventSource` cannot send an `Authorization` header. Putting the token in the URL is not acceptable. The web app opens the stream with `fetch` and the bearer header and reads it as a `ReadableStream`, parsing the `text/event-stream` format itself. Should the cookie migration the web guide anticipates land first, `EventSource` becomes possible and the parser is deleted; the plan does not wait for it.
2. **Fan-out is in-process.** The PRD's F10 fixes a single API instance, so the worker publishes transitions on an in-process Nest `EventBus` and the SSE controller subscribes. Multi-replica fan-out (PostgreSQL `LISTEN/NOTIFY`) is out of scope and named in the API guide as the change to make if a second replica ever appears.
3. **Events carry the whole `MeetingFile`, not a diff.** The client replaces the row by id. A missed event is harmless because reconnect refetches the list.
4. **The stream is per meeting**, scoped by the same visibility rule as every other route, and it closes itself after `MEETING_FILES_STREAM_TTL_SECONDS` (default `300`) so a tab left open reconnects rather than holding a connection forever.

## Design constraints

- **The worker is the single publisher.** Every call to `transition()` that changes status, and every purge, already logs the transition; the same place publishes a `MeetingFileChangedEvent(meetingId, file)` after the row is committed, never before. Upload and delete handlers publish too, so a second tab on the same meeting sees an upload without polling.
- **The stream never replaces the initial list.** On mount the page still calls `listMeetingFiles`, then opens the stream. The `MeetingFile` contract has no version field, so events are applied by a three-part rule rather than by comparing timestamps: an event for an id not in the list is inserted newest-first; an event for a known id replaces it; a `deleted` event removes it. Reconnect refetches the list and reopens the stream, so any gap between the two is closed by the refetch.
- **Fallback is the Phase 1 poll, unchanged.** If the stream request fails to open, or drops three times within a minute, `useMeetingFiles` runs the 3 second poll it already has until the page is left. The poll code is not deleted; it is the safety net the PRD's "no websocket in v1" spirit asks for.
- **Heartbeats every 15 seconds** (`: ping` comment lines) so proxies do not close an idle stream and the client can detect a dead one.

## Routes

| Method | Path                             | Who                 | Result                                                                                  |
| ------ | -------------------------------- | ------------------- | --------------------------------------------------------------------------------------- |
| `GET`  | `/api/meetings/:id/files/events` | host or participant | `200 text/event-stream`; `event: file`, `data: <MeetingFile JSON>`, `id: <ISO instant>` |

A stranger gets 404 `Meeting not found` before the stream opens. `Cache-Control: no-store`, `X-Accel-Buffering: no`.

## Implementation phases

### Phase 4.1: Publishing transitions and the event stream

**Goal:** every status change and purge is published inside the API, and a client that can hold an HTTP response open receives them for one meeting as they happen.
**Touches:** backend

**Tasks:**

- [ ] `MeetingFileChangedEvent` in `meeting-files/events/`, published from the worker after every committed transition and purge, and from the upload, delete, and (if present) retry handlers after their writes. Unit specs assert publication happens after the repository call resolves and not when the transition reports zero rows.
- [ ] `MeetingFileEventsService`: subscribes to the event on the `EventBus`, keeps a `Subject` per meeting id, and exposes `stream(meetingId): Observable<MessageEvent>` that merges the subject with a 15 second heartbeat and completes after the TTL. A subject with no subscribers is dropped. Unit spec with a marble-style test for heartbeat, TTL completion, and per-meeting isolation.
- [ ] `GET :id/files/events` on the controller as a Nest `@Sse` route behind the same guard and pipe, resolving visibility through `FindVisibleMeetingQuery` before returning the observable. Env: `MEETING_FILES_STREAM_TTL_SECONDS` (default `300`, `@Min(30)`) in `env.validation.ts`, `.env.example`, `turbo.json` if needed.
- [ ] Test helper: `test/utils/sse.ts` opens the route with Node's `http` (Supertest cannot hold a stream open), authenticates with the bearer header, and returns an async iterator of parsed events plus a `close()`.
- [ ] E2E spec `test/meeting-files-events.e2e-spec.ts`, red first: open the stream as host → upload a PNG from another request → an `uploaded` event arrives with the full `MeetingFile`; `drain()` → `processing` then `ready` events in that order, the `ready` one carrying `thumbnailPath`; delete → a `deleted` event; a stream on meeting A receives nothing when meeting B changes; a stranger gets 404 with the standard error body; the stream emits a heartbeat within 15 seconds and closes on its own when the TTL is overridden to 2 seconds; the app shuts down cleanly with a stream open (no dangling handle keeps Jest alive).

**Done when:** the events spec is green with every Phase 1 e2e spec unmodified; `curl -N` against `pnpm dev` shows the three events for one upload in the commit body; `pnpm build && pnpm typecheck && pnpm test` pass; the API guide documents the publisher rule and the single-instance fan-out assumption.

### Phase 4.2: The meeting page listens

**Goal:** on the meeting page the Processing chip disappears the moment the worker finishes, without a poll request in between, and the page still works when the stream cannot be opened.
**Touches:** frontend

**Tasks:**

- [ ] `src/lib/sse.ts`: `readEventStream(response, onEvent, signal)` parses `text/event-stream` from a `ReadableStream` (multi-line `data:`, `event:`, `id:`, comment lines ignored, CRLF and LF), with a Vitest test over a hand-built stream that includes a split chunk boundary mid-event.
- [ ] `api-client.ts`: `openMeetingFileEvents(token, meetingId, { signal }): Promise<Response>` through the guarded wrapper, asserting `content-type: text/event-stream`, 401 through the same clear-and-redirect path as every other call.
- [ ] `useMeetingFiles`: after the initial list, open the stream; apply events by the insert / replace / remove rule; on close or error, refetch the list and reopen with a backoff of 1, 2, 4 seconds; after three failures within a minute, fall back to the Phase 1 3 second poll for the rest of the page's life and stop trying the stream. Abort the stream on unmount. Unit-tested with a fake `fetch` that yields a scripted stream, including the fallback trigger.
- [ ] The 3 second poll is now conditional on "stream unavailable" rather than on `isProcessing`; the hook's doc comment states that the poll is the fallback and must not be removed.
- [ ] Playwright spec `apps/web/e2e/meeting-files-events.spec.ts`, red first: upload a PDF → the Processing chip disappears within 5 seconds and no `GET …/files` request other than the initial list and the one after the upload was made (assert on `page.on('request')`); a second tab on the same meeting shows the new row without reload; block the events route with `page.route(…, abort)` → the page falls back to polling and the chip still disappears within 10 seconds; navigating away closes the stream (no request stays pending in `page.on('requestfinished')` after leaving).

**Done when:** the Playwright spec is green with the Phase 1 browser suite; Vitest green; browser inspection in both themes with a clean console recorded in the commit body; the web guide's meeting page section describes the stream, the fallback, and why `EventSource` is not used yet.

## Documentation owed

- Root guide and `README.md`: `MEETING_FILES_STREAM_TTL_SECONDS`.
- API guide: the one-publisher rule, the in-process fan-out and its single-instance assumption, and the `sse.ts` test helper.
- Web guide: the `fetch`-based SSE reader, the reconnect and fallback policy, and the note that the cookie migration would allow `EventSource`.

## Out of scope

- Upload progress from the server. Upload progress is already per-file from the browser (Phase 1, and per chunk in Phase 2).
- Multi-replica fan-out.
- Streams for anything other than a meeting's files.
- Removing the poll. It stays as the fallback.
