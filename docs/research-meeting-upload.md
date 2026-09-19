# Research — implementing meeting file upload, storage, processing, and live status

**Date:** 2026-09-19
**Scope:** the four plans under `docs/plans/` for the meeting file upload PRD:
[Phase 1](plans/2026-09-19-meeting-file-upload-phase-1.md) (upload, list, download, delete, verify + preview pipeline),
[Phase 2](plans/2026-09-19-meeting-file-upload-phase-2.md) (chunked, resumable upload),
[Phase 3](plans/2026-09-19-meeting-file-upload-phase-3.md) (retry and transcription),
[Phase 4](plans/2026-09-19-meeting-file-upload-phase-4.md) (server-sent progress).
**Question:** for each technology decision the plans make or leave open, what is the best-supported choice in September 2026 on this repository's stack, and where do the plans need to change?

Every version, limit, and behaviour below was checked against the package registry, the project's lockfile and `node_modules`, official docs, or the upstream issue tracker on the date above. Where a claim comes from a local experiment (for example loading `file-type` under Jest) it says so.

## The stack the plans run on

| Fact                     | Value                                                                                                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API                      | Nest.js 11.1.28 on the Express adapter, `@nestjs/cqrs` 11.0.3, `rxjs` 7.8                                                                                                  |
| Build and tests          | `tsc` to CommonJS (`packages/tsconfig/nestjs.json`), Jest 30.4.2 + ts-jest 29.4.12, Node 24.19                                                                             |
| Database                 | PostgreSQL 17, Prisma 7.9.1 with `@prisma/adapter-pg` over `pg` 8.22                                                                                                       |
| Already in the lockfile  | `multer` 2.2.0 (pinned by Nest), `busboy` 1.6.0, `sharp` 0.34.5, `file-type` 21.3.4 + `load-esm` (inside `@nestjs/common`), `content-disposition` 1.1.0 (inside Express 5) |
| Already allowed to build | `sharp` is in `allowBuilds` in `pnpm-workspace.yaml`                                                                                                                       |
| Docker                   | `node:24-alpine`; `pnpm install` runs inside the Alpine builder stage; runtime user `nestjs` uid 1001                                                                      |
| Web                      | Next.js 16.2, React 19.2, HeroUI 3.2; JWT in `localStorage`, sent as a bearer header                                                                                       |
| Ecosystem note           | Nest 12 shipped in August 2026; Nest 11 continues as 11.2.x (11.2.5 on 2026-09-15). `@nestjs/cqrs` 12 is Nest 12 only.                                                     |

## Summary of changes the plans should absorb

| Plan    | Where                      | Current text                                                | Change to                                                                                                                                                                                                                                          |
| ------- | -------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 1 | Design decision 4          | Pin `file-type` 16.5.4 because 17+ is ESM-only              | Use current `file-type` (22.x) through `require()`; Node 24 loads ESM from CommonJS. Jest needs `NODE_OPTIONS=--experimental-vm-modules`.                                                                                                          |
| Phase 1 | Task 1, allow-list comment | `file-type` reports `audio/vnd.wave` for WAV                | It reports `audio/wav` and `audio/mp4` for M4A. No remap is needed. Delete the comment.                                                                                                                                                            |
| Phase 1 | Task 6, name rule          | Convert `latin1` only if the UTF-8 test fails               | Pass `defParamCharset: 'utf8'` in the multer options. The option exists in multer 2.1+, so the conversion is never needed.                                                                                                                         |
| Phase 1 | Task 6, deps               | `content-disposition@0.5.4` + types                         | Use Express's `res.attachment(name)` or the `content-disposition` 1.1.0 that Express already ships. Version 3 is ESM-only.                                                                                                                         |
| Phase 1 | Design decision 6 / worker | Multer's temp files are removed by the handler              | Add a sweeper: the worker also unlinks files in `tmp/` older than one hour. Multer 2.2.0 leaves orphans on aborted requests (CVE-2026-88932).                                                                                                      |
| Phase 1 | Design decision 2 / Task 9 | Lease times computed in the handler                         | Compute every lease time in SQL (`now() + interval`) and run the pool with `timezone=UTC`. Prisma 7 with driver adapters has open `timestamptz` offset bugs.                                                                                       |
| Phase 1 | Task 9, worker lifecycle   | `OnApplicationShutdown` awaits the in-flight tick           | Stop the timer in `onModuleDestroy`, await the tick in `beforeApplicationShutdown` with a deadline, then abort and let the lease expire.                                                                                                           |
| Phase 1 | Task 5, thumbnail          | `sharp(path).rotate()`                                      | `sharp(path, { autoOrient: true })`. Keep the default `limitInputPixels`. First frame of a GIF is the default.                                                                                                                                     |
| Phase 2 | Design constraints         | Chunks as separate files, stream-concatenated on completion | Preallocate the staging file with `ftruncate(size)` and write each chunk at `index * chunkSize`. No assembly step, idempotent by construction.                                                                                                     |
| Phase 3 | Assumption 3               | OpenAI-compatible endpoint, provider is configuration       | Keep the interface, but add ffmpeg to the API image and an audio-extract-and-segment step. OpenAI's models cap requests at 25 MB and 1500 s; an hour-long recording never fits. Self-hosted Speaches, Deepgram, and AssemblyAI accept whole files. |
| Phase 4 | Phase 4.1, task 3          | Resolve visibility in the `@Sse` handler                    | Resolve it in a guard. Nest commits the SSE headers before the handler runs, so a 404 thrown inside becomes an error frame, not a 404.                                                                                                             |
| Phase 4 | Phase 4.2, task 1          | Hand-written `text/event-stream` parser over `fetch`        | Use `eventsource` 5.x, which accepts a `fetch` option for the bearer header and gives reconnection and `Last-Event-ID` for free.                                                                                                                   |
| Phase 4 | Phase 4.1                  | Client disconnect via `finalize()`                          | Upgrade to `@nestjs/*` ^11.2.5 for `@SseSignal()`, and complete every SSE subject in `beforeApplicationShutdown` (Nest issue #9517).                                                                                                               |

Everything else in the plans holds up. The sections below give the evidence.

## 1. Receiving multipart uploads (Phase 1)

### multer versus the alternatives

- **multer** latest is 2.4.0 (2026-09-14), MIT. Nest 11.1.28 pins 2.2.0; Nest 12 pins 2.4.0. `busboy` 1.6.0 underneath has had no release since 2022 but depends only on `streamsearch`, not the vulnerable `dicer` of busboy 0.x. `@fastify/busboy` is the maintained fork.
- **Ten security advisories in 2025 and 2026, all denial-of-service.** The one that matters for this design is CVE-2026-88932 (GHSA-3pph-fpjx-jg34): orphaned disk writes when a request aborts, affecting 2.2.0 through 2.3.x and fixed only in 2.4.0. Four more advisories were fixed in 2.3.0 (fd leak on abort, crafted field names, oversized array index, async `fileFilter` bypass).
- **Upgrading multer past Nest's pin is not free.** Nest 11.1.28 maps multer errors to HTTP status by matching the error message text; multer 2.4.0 changed the `LIMIT_UNEXPECTED_FILE` message, which turns that 400 into a 500. Nest fixed it by matching on `code` in PR #17769 (merged 2026-09-16, in 12.0.2, not yet in an 11.2.x release).
- **`@fastify/multipart`** 10.1.1 is maintained but requires switching the HTTP adapter. **busboy direct** gives nothing that `multer.diskStorage` does not already stream.

**Recommendation.** Keep `FileInterceptor` with `multer.diskStorage` into `<MEETING_FILES_DIR>/tmp`, `limits: { fileSize: MAX, files: 1, fields: 0 }`, and stay on the version Nest pins. Cover the orphan-on-abort advisory operationally: the worker sweeps `tmp/` for files older than an hour. Watch Nest 11.2.x for the `code`-based error mapping and move to multer 2.4.0 when it lands. Never use memory storage.

### Filename encoding

busboy decodes multipart header parameters as `latin1` by default, which is the bug behind garbled UTF-8 filenames. multer 2.1.0 added `defParamCharset`, and the installed 2.2.0 forwards it. Pass `defParamCharset: 'utf8'` in the interceptor options and the `Buffer.from(name, 'latin1')` workaround the Phase 1 plan holds in reserve is never needed. multer 2.3.0 additionally unescapes `%0A`, `%0D`, `%22` in `originalname`; until then, the plan's control-character rejection in `normaliseFileName` covers those.

### How limits surface

`@nestjs/platform-express` maps `LIMIT_FILE_SIZE` to `PayloadTooLargeException` (413) and every other `LIMIT_*` and busboy error to `BadRequestException`. The Phase 1 plan's thin interceptor that rewrites the 413 message is the right shape. multer does not document whether the partial file remains on disk after `LIMIT_FILE_SIZE`; assume it does, which is one more reason for the sweeper.

## 2. Content sniffing (Phase 1)

### `file-type` is usable from CommonJS on Node 24

- Latest `file-type` is 22.1.1 (2026-09-17), MIT, ESM-only, Node ≥ 22. There is no CommonJS build and there will not be one.
- Node has supported `require()` of an ES module without a flag since 22.12 and 20.19, without a warning since 22.13, and marks it stable in 25.4. The only failure mode is a module graph with top-level `await`, which `file-type` does not have. **Verified locally:** `require('file-type')` on Node 24.19 works, and `process.features.require_module` is `true`.
- `@nestjs/common` 11.1.28 already bundles `file-type` 21.3.4 and `load-esm` for its own `FileTypeValidator`, so a modern `file-type` is already part of the install.

**The Phase 1 pin to 16.5.4 should be dropped.** It gives up five years of signature updates for a problem the runtime has solved.

### The Jest caveat

Jest 30.4.0 added `require()` of ES modules on Node ≥ 24.9, but jest-runtime only gets the synchronous `vm` API it needs under `--experimental-vm-modules`. **Verified locally with the project's Jest 30.4.2 and ts-jest 29.4.12:** `require('file-type')` fails with "Cannot use import statement outside a module", and both native `import()` and Nest's `load-esm` path fail with "A dynamic import callback was invoked without --experimental-vm-modules". All three succeed with `NODE_OPTIONS=--experimental-vm-modules`. This matches Nest issue #15055.

Consequence: the API's `test` and `test:e2e` scripts need `NODE_OPTIONS=--experimental-vm-modules`, and the pre-commit hook runs `pnpm test`, so this has to land with the first import of `file-type`. The alternative of mocking the sniffer in unit tests still leaves the e2e suite needing the flag.

### Detection coverage

`file-type` detects DOCX, XLSX, and PPTX by inspecting the ZIP's entries, which needs the whole file, not a 4 KiB head. Use `fileTypeFromFile` on the staged path. Detected types relevant to the allow-list, verified by probing fixtures: WebP as `image/webp`, WebM as `video/webm`, M4A as `audio/mp4`, **WAV as `audio/wav`**. The Phase 1 plan's remap from `audio/vnd.wave` is unnecessary and its comment on the allow-list should be deleted. Text formats are explicitly not detected, so the plan's UTF-8 fallback with extension-picked subtype stays.

### Alternatives considered and rejected

`magic-bytes.js` 1.13.1 is CommonJS but a pure signature table, so it cannot tell a DOCX from a ZIP. `mmmagic` (2019, native addon) and `detect-file-type` (2020) are dead. `@file-type/xml` is a plugin for `file-type`, not a replacement.

## 3. Thumbnails (Phase 1)

- `sharp` 0.34.5 in the lockfile is libvips 8.17.3. Latest is 0.35.4 (2026-08-26). 0.35.0 dropped Node 18, **removed the install-time build-from-source fallback** (a platform with no prebuilt binary now fails at runtime rather than at install), and added `limitInputChannels`.
- **Alpine:** prebuilt `@img/sharp-linuxmusl-*` needs musl ≥ 1.2.5. `node:24-alpine` tracks Alpine 3.24, which qualifies. The classic failure is installing on macOS or glibc and copying `node_modules` into Alpine. The API Dockerfile runs `pnpm install` inside the Alpine builder stage, so this does not apply. `pnpm.supportedArchitectures.libc: ["glibc", "musl"]` is the fix if the build ever moves out of the image.
- **Behaviour the plan relies on:** by default sharp reads only the first frame of an animated GIF or WebP, which is what a thumbnail wants. `autoOrient: true` in the constructor applies the EXIF orientation and strips the tag; prefer it over a parameter-less `.rotate()`, which has known edge cases when combined with a second rotate.
- **Path input, not a buffer.** libvips shrinks JPEG on load and streams from disk with `sequentialRead`, so a 100 MB image costs a fraction of its size in memory. A `Buffer` input pins the whole encoded file plus the decode. Keep the default `limitInputPixels` (268 megapixels) and never set `unlimited` for user input.
- **Alternatives:** `jimp` (pure JS, roughly forty times slower), `@napi-rs/image` (no GIF), `wasm-vips` (same engine, two to eight times slower), and sharp's own `@img/sharp-wasm32` as a drop-in when native binaries are missing. Keep sharp.
- **Video thumbnails** (not in the PRD): `fluent-ffmpeg` is deprecated on npm and `ffmpeg-static` is GPL with an 80 MB postinstall download. If video thumbnails are ever wanted, `apk add ffmpeg` in the image and `spawn('ffmpeg', [...], { signal, timeout })` is the cheaper and cleaner route, and it is the same binary Phase 3's transcription needs.

## 4. Serving downloads (Phase 1)

- **`StreamableFile`** sets `Content-Type`, `Content-Disposition`, and `Content-Length` only when absent and pipes with `stream.pipe(response)`. Nest 11 ships the fix for the crash when a client aborts mid-stream (PR #15010), but with `pipe()` a client abort does not destroy the source `fs.ReadStream` on its own. Listen for `res.on('close')` and `stream.destroy()`, or create the stream with `autoDestroy`. **It does not implement Range requests.**
- **Range support** for audio and video previews, if ever wanted, is Express's `res.sendFile(path, { root, acceptRanges: true })` through `@Res()`, which goes through `send` 1.2.1 with `Accept-Ranges`, 206, ETag, and dotfile handling. Always pass `root`, and override `Content-Type` with the sniffed type.
- **`Content-Disposition`:** `content-disposition` 3.0.0 (2026-08-13) is ESM-only, Node ≥ 22, and renamed its export to `create` in 2.0. Express 5.2.1 still bundles 1.1.0 and exposes it through `res.attachment(filename)`, which emits both `filename` and `filename*=UTF-8''…` per RFC 6266. Use that, or `require('content-disposition')` at the version Express ships. The Phase 1 plan's `content-disposition@0.5.4` pin is outdated on both counts. There is no Node or WHATWG built-in for formatting this header.
- **Headers** the plan already specifies are right: `X-Content-Type-Options: nosniff`, the sniffed type never the client's, `attachment` for everything. The PRD's exclusion of HTML and SVG from the allow-list is the correct defence; if an inline-renderable type is ever served inline, add `Content-Security-Policy: sandbox; default-src 'none'` to that response.

## 5. The processing worker (Phase 1, extended by Phase 3)

### Hand-rolled `SKIP LOCKED` versus a library

| Option             | Version                   | Leases and heartbeat                                                                                     | Coexistence with Prisma                                                                           | Verdict                                                                                                                                  |
| ------------------ | ------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Hand-rolled poller | —                         | You write the lease column, the heartbeat update, and the reaper                                         | Lives in your Prisma schema; the claim is one `$queryRaw`                                         | What the Phase 1 plan does. Fine for one queue with two steps.                                                                           |
| `pg-boss`          | 12.33.2 (2026-09-18), MIT | `expireInSeconds` lease, `heartbeatSeconds` renewal, exponential backoff with jitter, dead-letter queues | Own `pgboss` schema; accepts an `executeSql` adapter, so it can share a `pg.Pool` with `PrismaPg` | The only PostgreSQL-only library with real heartbeats. Worth it if the queue grows past one job type. Very fast release cadence; pin it. |
| `graphile-worker`  | 0.18.0 (2026-09-08), MIT  | No heartbeat; a job held by a crashed worker stays locked four hours; crash recovery is a paid feature   | Accepts an existing pool                                                                          | Disqualified by the missing heartbeat, which the PRD's "worker dies mid-file" criterion needs.                                           |
| BullMQ             | —                         | —                                                                                                        | Needs Redis                                                                                       | Excluded by the PRD.                                                                                                                     |

Polling cost on one instance is one indexed `UPDATE … SKIP LOCKED` per tick, the same thing the libraries do; `LISTEN/NOTIFY` reduces pickup latency, not cost. The Phase 1 plan's choice stands. The shape to preserve so `pg-boss` remains a drop-in later: claim in one statement, work outside any transaction, finish with a conditional update.

### Prisma 7 specifics that change the plan

- `$queryRaw` expresses `FOR UPDATE SKIP LOCKED`, and raw queries work on the `tx` client inside `$transaction(async tx => …)`. The interactive transaction defaults (`maxWait` 2 s, `timeout` 5 s) suit "lock the meeting row, count, insert" as long as no I/O sits inside the callback. **Never hold the claim transaction across a step**; claim and commit, then work, then update.
- **Open `timestamptz` bugs with driver adapters** (prisma/orm#28629, prisma#26786): `Date` parameters and `@db.Timestamptz` values come back offset when the session timezone is not UTC. Two rules follow. Compute every lease time in SQL (`now() + interval '60 seconds'`, `leased_until < now()`), never by passing a JavaScript `Date`, and set the pool's session timezone to UTC (`options: '-c timezone=UTC'` or `TZ=UTC`). Tests should assert against server-side `now()`.
- Prisma maps `DateTime` to `timestamp(3)` unless the field says `@db.Timestamptz(3)`. The PRD's model does, on every timestamp. Keep that on `purged_at` and the Phase 2 and 3 additions.

### Lifecycle and shutdown in Nest 11

Order on a signal, given `enableShutdownHooks()` which `main.ts` already calls: `onModuleDestroy` → `beforeApplicationShutdown(signal)` → server close → `onApplicationShutdown(signal)`. Every hook may be async and is awaited. The pattern for the worker: stop the poll timer and set a stopping flag in `onModuleDestroy`; in `beforeApplicationShutdown` await the in-flight tick up to a deadline, then abort it through an `AbortController` and let the lease expire so the row is retried after restart. That is a small correction to Phase 1's Task 9, which puts the await in `onApplicationShutdown`.

Jest 30 reports open handles even for `unref()`'d timers, so the worker must be opt-in in tests. The Phase 1 plan's `MEETING_FILES_WORKER_ENABLED=false` in `setup-env.ts` plus a `drain()` handle is exactly right. Do not lean on `--forceExit`.

### Bounding a step (Phase 3)

Node 24 has everything needed and no library is required: `AbortSignal.timeout(ms)` (unref'd, rejects with a `TimeoutError`), `AbortSignal.any([...])` to combine timeout, shutdown, and lost-lease signals (the timeout bug in `any` was fixed in 24.0; keep references to the source signals for the step's lifetime because of a GC edge case, node#65995), `fetch(url, { signal })`, `pipeline(..., { signal })` from `node:stream/promises`, and `spawn(cmd, args, { signal })` for a child ffmpeg. The heartbeat is `setInterval` at `lease / 2` running a conditional `UPDATE … WHERE id = $1 AND status = 'processing'`; zero rows means the lease was lost and the step is aborted. `pg-boss` does the same with `heartbeatRefreshSeconds`.

## 6. Chunked, resumable upload (Phase 2)

### Protocols

- **tus 1.0 via `@tus/server`** 2.4.5 (2026-08-31), MIT, actively released, **ESM-only since 2.0**. It loads from the CommonJS build on Node 24 (no top-level await) with the same Jest flag as `file-type`. Its Express integration is a raw `app.all('/uploads/*', server.handle)`, so in Nest it sits outside guards, pipes, and the exception filter unless wrapped. `FileStore` writes at offsets with no `fsync`; PATCH enforces `Upload-Offset` and answers 409 on mismatch; expiry and cleanup are built in. `tus-js-client` stores fingerprints in `localStorage`, so resume-after-reload once the file is re-picked comes for free.
- **IETF Resumable Uploads for HTTP** is `draft-ietf-httpbis-resumable-upload-12` (2026-07-06), still a working-group document. **No browser implements it, and there is no Node server**; tus-node-server declined it. Not an option in 2026.
- **Uppy** 6 (2026-08) is the tus client with a UI; it brings Preact and its own components, which is a lot for one progress bar next to HeroUI.
- **Custom session protocol** as the Phase 2 plan sketches: least risk for a single instance, stays inside Nest's guard and DTO model, and the code is small.

**Recommendation.** Custom protocol, with two refinements to the Phase 2 plan.

1. **Write chunks at offsets into one preallocated file** (`fs.open(path, 'r+')`, `ftruncate(size)` at session creation, `write(buf, 0, len, index * chunkSize)`), instead of one file per chunk assembled by stream concatenation. Rewriting chunk _n_ produces the same bytes, so idempotency is by construction; there is no assembly copy of a gigabyte; completion is sniff, hash, `fsync`, and an atomic `rename` on the same filesystem. Keep the `received_chunks` bitmap in the row so out-of-order and resumed uploads still work; `fsync` the fd after each chunk or at minimum before `complete`.
2. **Answer 409 with the expected state on a mismatched chunk** the way tus does with `Upload-Offset`, so the client's recovery is always "ask the server what it has, then continue".

`@tus/server` is the fallback if the browser-side resume logic turns out to be more work than expected, at the cost of an ESM dependency mounted outside Nest's pipeline.

### Browser side

- **Progress:** `XMLHttpRequest.upload` `progress` events are universal. `fetch` has no upload progress, and streaming request bodies are Chromium-only, require HTTP/2, need `duplex: 'half'`, and always preflight; Firefox has it only in Nightly. Phase 1's XHR decision and Phase 2's XHR-per-chunk stand.
- **Resume after reload:** persisting a `FileSystemFileHandle` in IndexedDB and re-requesting permission is Chromium-only. The portable path is what the Phase 2 plan assumes: remember the session id under a fingerprint (name, size, `lastModified`) and ask the user to pick the same file again.
- **`accept` filtering** is advisory and OS-dependent: CSV is `text/csv` on macOS and `application/vnd.ms-excel` on Windows, and `.md` often has no MIME at all, so `File.type` is frequently empty. List extensions and MIME types both, and validate by extension on the client, which is what Phase 1's `validateFileBeforeUpload` does.

## 7. Transcription (Phase 3)

| Provider                                                                   | Interface                                                       | Limits                                                           | Cost                         | Needs ffmpeg                                                            | Takes MP4 and WebM directly |
| -------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------- | --------------------------- |
| OpenAI (`gpt-transcribe`, `gpt-4o-transcribe`, `whisper-1`)                | `POST /v1/audio/transcriptions`, multipart, optional SSE stream | **25 MB per request**; `gpt-4o-transcribe` also rejects > 1500 s | $0.0045 to $0.006 per minute | Yes for anything over 25 MB or 25 minutes: extract 16 kHz mono, segment | Yes, within the limit       |
| Speaches (formerly faster-whisper-server), self-hosted                     | Same OpenAI shape, SSE streaming, diarization in 0.9 rc         | Whatever the host can do                                         | Hosting                      | No, decodes through bundled PyAV                                        | Yes                         |
| Deepgram Nova-3                                                            | REST, binary body or URL, async callback                        | 2 GB; request must finish in 10 minutes                          | about $0.0043 per minute     | No                                                                      | Yes                         |
| AssemblyAI                                                                 | Async upload then transcript job                                | 5 GB, 10 hours                                                   | $0.15 to $0.21 per hour      | No                                                                      | Yes                         |
| whisper.cpp server, LocalAI                                                | Own or OpenAI-shaped                                            | Host-bound                                                       | Hosting                      | Yes                                                                     | Via ffmpeg                  |
| In-process Node (`@huggingface/transformers` 4.3, `sherpa-onnx-node` 1.13) | Library call                                                    | CPU-bound, 30 s windows, needs VAD                               | Free                         | Yes, to decode to 16 kHz PCM                                            | No                          |

**What this means for the Phase 3 plan.** The OpenAI-shaped port is the right abstraction because OpenAI and self-hosted Speaches are interchangeable behind it, and the `openai` SDK 7.x forwards an `AbortSignal` per request. But the plan's assumption that the provider is "just configuration" breaks on OpenAI's 25 MB and 1500 s limits: an hour-long meeting recording never fits. Two ways to close the gap, and the plan should pick one before Phase 3.3 starts:

1. **Add ffmpeg to the API image** (`apk add ffmpeg`, roughly 60 MB) and an extract-and-segment step before the provider call: `ffmpeg -i in -vn -ac 1 -ar 16000 -c:a libopus` then `-f segment -segment_time 1200 -reset_timestamps 1`, transcribe segments sequentially, concatenate. This keeps OpenAI viable and also unlocks video thumbnails later. Run ffmpeg with `spawn(..., { signal })`, a timeout, `-nostdin`, and only on sniffed audio and video types.
2. **Choose a provider that accepts whole files** (Speaches self-hosted, Deepgram, AssemblyAI) and keep the worker ffmpeg-free. Deepgram's ten-minute request budget still needs the async callback mode for long files.

In-process Whisper in Node is CPU-bound and would starve the API's event loop; treat it as a fallback that would need a worker thread or separate process, which the PRD's "no new infrastructure" rules out for now.

## 8. Server-sent events (Phase 4)

### Server

- Nest 11's `@Sse()` returns `Observable<MessageEvent>` with `data`, `id`, `type` (rendered as `event:`), and `retry`. Its `SseStream` already sets `Content-Type: text/event-stream`, `Cache-Control: … no-transform`, `Connection: keep-alive`, and **`X-Accel-Buffering: no`**, flushes headers, and disables Nagle. The Phase 4 plan does not need to set those itself. `no-transform` also makes Express `compression` skip the route, and the API does not use compression anyway.
- **Nest sends no heartbeat.** The plan's 15 second comment frame is right; nginx's default `proxy_read_timeout` is 60 s, so anything under that works.
- **Headers are committed before the handler runs** (Nest issue #12670). An `HttpException` thrown inside an `@Sse` handler becomes an SSE error frame, not a 4xx. **This breaks the Phase 4 plan's "a stranger gets 404 before the stream opens" if the visibility check lives in the handler.** Move it into a guard that dispatches `FindVisibleMeetingQuery` and throws `NotFoundException`; guards run before the stream is committed. The handler itself must be infallible.
- **`@SseSignal()`**, a request-scoped `AbortSignal` for detecting client disconnect, was added in Nest 11.2.0 (2026-08-14). The project is on 11.1.28. Upgrade to `^11.2.5`; it is a minor bump within Nest 11 and also positions the API for the multer error-mapping fix when it is backported.
- **Graceful shutdown with open streams** (Nest issue #9517, still open): open SSE responses can keep `server.close()` from finishing. Complete every per-meeting `Subject` in `beforeApplicationShutdown`, and cover it in the e2e spec the plan already lists ("the app shuts down cleanly with a stream open").
- WebSockets (`@nestjs/websockets` with `platform-ws` or socket.io) are overkill for one-way status pushes and would add a second transport to secure.

### Client

The token lives in `localStorage`, so native `EventSource`, which cannot set headers, is out, and putting the token in the URL is not acceptable. Options, in order of preference:

1. **`eventsource` 5.1.1** (MIT, 2026-08-20, Node ≥ 22.12, browsers Chrome 84+, Safari 15+, Firefox 105+): a spec-compliant `EventSource` with a `fetch` option through which the bearer header is injected, plus automatic reconnection and `Last-Event-ID`. This replaces the Phase 4 plan's hand-written parser and most of its reconnect logic.
2. **`eventsource-parser` 4.1.1** (MIT, 2026-09-15): `EventSourceParserStream` for `fetch().body.pipeThrough(new TextDecoderStream())` if a zero-dependency reader with the plan's own backoff policy is preferred.
3. `@microsoft/fetch-event-source` and its forks: last published five years ago. Avoid.
4. Moving the token to a cookie would enable native `EventSource`, but that is the separate cookie migration the web guide anticipates, not something Phase 4 should wait for.

### If a second replica ever appears

PostgreSQL `LISTEN/NOTIFY` is the no-new-infrastructure fan-out: payload under 8000 bytes, delivered at commit, lost if nobody is listening. It needs a dedicated `pg.Client` (not the pool, and Prisma has no `LISTEN` API) with its own reconnect-and-re-`LISTEN` loop; `pg-listen` has been unmaintained since 2022, so the loop is roughly forty lines of your own. Send only ids and have the SSE side re-read the row. The Phase 4 plan's `MeetingFileEventsService` should be the one place that would change.

## 9. Observability

The PRD asks for transition logs with `fileId`, `meetingId`, from, to, and duration. Nest's built-in `Logger` can do that with a formatted message. `nestjs-pino` 5.2.0 (MIT, 2026-09-14, peers Nest 11 and 12) is the pragmatic step up if structured JSON is wanted: `app.useLogger(app.get(Logger))` keeps every existing `new Logger(context)` call working, and a child logger keyed by `fileId` and `meetingId` covers the worker. OpenTelemetry's Nest instrumentation (0.68.0) only spans controller handlers, would need manual spans for the pipeline, and needs a collector, which is new infrastructure. Not now.

## 10. Risks, ranked

1. **multer 2.2.0 carries the 2026 abort-cleanup advisories** and the fix conflicts with Nest 11's error mapping until 11.2.x picks up the `code`-based fix. Mitigation: staging-directory sweeper now, upgrade when Nest allows.
2. **Jest cannot load `file-type` without `--experimental-vm-modules`**, and the pre-commit hook runs the suite. Put the flag in the scripts in the same commit as the first import.
3. **Prisma 7 `timestamptz` offset bugs** make lease math in JavaScript wrong under a non-UTC session. Compute in SQL and pin the session timezone.
4. **A 404 cannot be raised inside an `@Sse` handler.** The visibility guard is not optional.
5. **OpenAI's 25 MB and 1500 s limits** make ffmpeg unavoidable for meeting-length recordings on that provider. Decide provider or ffmpeg before Phase 3.3.
6. **`sharp` 0.35 fails at runtime, not install, on an unsupported platform.** The Alpine-stage install protects this; do not move `pnpm install` out of the image.
7. **Open SSE streams can hang shutdown** (Nest #9517). Complete subjects before the server closes.
8. **Resume without re-picking the file is Chromium-only.** The plan's re-pick assumption is the portable design; do not promise more in the UI copy.
9. **Dependency churn.** Nest 12 is out, `@nestjs/cqrs` 12 is Nest 12 only, and `pg-boss` migrates its schema weekly. Pin everything and plan the Nest 12 move as its own change after Phase 1.
