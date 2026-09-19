# Meeting File Upload — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Phase 1 of the meeting file upload PRD — upload, list, download, delete, and an asynchronous verify + preview pipeline over local-disk storage — plus the `/meetings/[id]` page that hosts it.

**Architecture:** A new `apps/api/src/modules/meeting-files` module in the house CQRS shape (`UploadMeetingFileCommand`, `DeleteMeetingFileCommand`, reads on `MeetingFilesService`) that reaches the meetings module only through a new `FindVisibleMeetingQuery`. Storage is one `MeetingFileStorage` provider over `fs`. Processing is an in-process polling worker that claims rows with `FOR UPDATE SKIP LOCKED`, runs a list of steps, and purges the bytes of soft-deleted rows. The web app gets its second client-gated page, with the gate extracted into a hook, and its first browser-level end-to-end suite.

**Method:** Every task is test-first at the end-to-end level. The task's e2e spec is written and run **red** before any implementation, the failure is recorded so it can be recognised as the expected one, and the task is done only when that same spec — unmodified — is green alongside everything written before it. See _Test-first protocol_.

**Tech Stack:** Nest.js 11, `@nestjs/cqrs`, Prisma 7, multer (via `@nestjs/platform-express`), `file-type` 16 (last CJS release), `sharp`, `content-disposition`, Jest + Supertest; Next.js 16, React 19, HeroUI 3, Vitest, `@playwright/test` for the browser e2e suite.

**PRD:** [`docs/superpowers/specs/2026-09-19-meeting-file-upload-prd.md`](../specs/2026-09-19-meeting-file-upload-prd.md)

This plan also settles the decisions the PRD deferred to "the design spec" (worker placement, thumbnail library, storage layout, module file layout). They are recorded in _Design decisions_ below rather than in a separate spec, so a worker executing a task never has to reconcile two documents. If a standalone spec is wanted for the record, lift that section into `docs/superpowers/specs/` verbatim and point the root guide at it.

## Test-first protocol

Each task below has the same skeleton, and the order is the point:

1. **Write the e2e spec(s) for the task.** API tasks add a `test/<name>.e2e-spec.ts` (Jest + Supertest against the real database, via `useApiSuite`). Web tasks add a `apps/web/e2e/<name>.spec.ts` (Playwright, against the real API and a real browser). The spec asserts the task's whole observable contract: routes, status codes, exact messages, response shapes, headers, what is on disk, what is in the table, and what is on screen.
2. **Run the spec and confirm it fails for the right reason.** Record the failure in the task's checklist — "404 because the route does not exist", "relation `meeting_files` does not exist", "locator `Add file` not found". A spec that passes before the implementation exists is asserting nothing and must be fixed before moving on. A spec that fails to _compile_ is not red, it is broken; a spec must compile against the pre-implementation tree, which is why the test helpers read the database over raw SQL and why fixtures restate constants rather than importing generated code.
3. **Implement**, adding the unit specs beside the code as the API guide requires (they are for CI, which does not run e2e; the e2e spec is the contract).
4. **Run the task's e2e spec green, then every earlier e2e spec green, unmodified.** `pnpm --filter=@repo/api test:e2e` for API tasks; `pnpm --filter=@repo/web test:e2e` for web tasks; plus `pnpm --filter=<app> test` for the unit layer. An earlier spec that now needs editing means behaviour changed — stop and report.
5. **Commit** the spec and the implementation together. The commit body names the spec and states that it was red before and is green after.

Tasks 1–4 lay foundations with no HTTP surface of their own. Each still gets a red-first check, described in the task, and the plan says explicitly when a task has nothing an e2e can see.

**Where the red-first spec runs against a missing dependency, that is expected.** Task 5's list spec is red because the route is a 404; Task 9's worker spec is red because `MeetingFileWorker` does not exist, so the spec must `app.get()` it through a string token or an `import` that resolves — the plan tells each task how to keep the spec compiling.

### The web e2e suite

The web app has no browser test runner today, and the web guide's argument against React Testing Library does not apply here: Playwright drives the real page against the real API, which is exactly the "browser inspection is the stronger check" the guide prefers, made repeatable. Task 10 introduces it:

- `@playwright/test` as a dev dependency of `@repo/web`, `apps/web/playwright.config.ts`, specs under `apps/web/e2e/`, script `test:e2e` (`playwright test`). Chromium only. Not in `turbo.json` and not in CI, for the same reason the API's `test:e2e` is not: it needs Postgres and the API running. Document that alongside the API's note.
- The config's `webServer` starts both apps: the API with `pnpm --filter=@repo/api start:e2e-web` (a new script: `MEETING_FILES_DIR` to a temp dir, a fixed `PORT=3101`, `MEETING_FILES_WORKER_ENABLED=true` — the browser suite needs the real pipeline so "the chip disappears" is testable) and the web app with `WEB_PORT=3100 NEXT_PUBLIC_API_URL=http://localhost:3101/api`. Playwright's `reuseExistingServer` is off, so the ports are the suite's own.
- Every spec signs up a fresh user through the UI (`/auth/register`) with a unique email per test, creates a meeting through the API from the test (there is no create-meeting page yet), and navigates to `/meetings/<id>`. A `test/fixtures.ts` in the e2e folder holds the sample files (a PNG, a PDF, an HTML file, a text file) and the helpers.
- The suite runs in a separate process from the API, so it cannot call the API's raw-SQL truncation helper. Instead every test uses unique emails and its own meeting, so no cleanup is needed for correctness; a `globalTeardown` truncates `users` through a direct `pg` connection so the developer database is left as it was found, mirroring `useApiSuite`'s `afterAll`.

## Design decisions

These are settled. A task that finds one of them unworkable stops and reports rather than picking an alternative silently.

1. **Worker placement: in-process, behind `MEETING_FILES_WORKER_ENABLED` (default `true`).** `pnpm dev` runs one API process and the PRD forbids new infrastructure. A second entry point would be a second thing to start in every environment, for a pipeline whose two steps take milliseconds. The cost — every replica polls — is bounded by the claim query being one indexed `UPDATE … SKIP LOCKED` per tick and is switched off per replica by the flag. The API e2e suite runs with the flag off and drives the worker by hand, so tests are deterministic (see Task 9); the browser suite runs with it on.
2. **Claiming is a single SQL statement, not read-then-write.** `UPDATE meeting_files SET status = 'processing', leased_until = now() + lease, attempts = attempts + 1 WHERE id = (SELECT id … FOR UPDATE SKIP LOCKED) RETURNING …`. Two replicas cannot claim one row, and a worker that dies leaves a row whose lease expires and is reclaimed. Prisma's query builder cannot express this; it is `$queryRaw` in one place, `MeetingFileRepository.claimNext`.
3. **Purge needs a marker the PRD's model lacks: `purgedAt`.** After a soft delete the worker must remove the object exactly once and know it has done so. Without a column, "deleted rows still holding bytes" is unknowable. `purged_at TIMESTAMPTZ NULL` is the smallest addition; deleted rows are claimed with the same lease so a crash mid-`unlink` is retried. This is the one deviation from the PRD's schema sketch.
4. **Content sniffing is `file-type` 16.5.4 plus a text fallback.** `file-type` ≥ 17 is ESM-only, which the CJS build (`moduleFormat = "cjs"`, ts-jest) cannot load without dynamic-import gymnastics; 16.5.4 is the last CJS release and detects every binary type on the allow-list, including DOCX/XLSX/PPTX by reading the zip's entries. Plain text, Markdown, and CSV have no magic bytes: when `file-type` detects nothing, the bytes must decode as UTF-8 with no NUL byte, and the extension of the trimmed name picks **only among the three text subtypes** (`.md`/`.markdown` → `text/markdown`, `.csv` → `text/csv`, anything else → `text/plain`). An extension never elevates a file to a binary type, so `page.html` renamed to `page.pdf` sniffs as text with a `.pdf` extension, which is not `.txt`/`.md`/`.csv` → 415. A `.txt` holding HTML is stored as `text/plain` and served as an attachment with `nosniff`, which is not an XSS vector.
5. **Thumbnails: `sharp`.** Already in `allowBuilds` (Next uses it), already in the lockfile, so no workspace change. 320 px longest side, WebP, stored at `<storageKey>.thumb.webp`. GIF uses the first frame.
6. **Multipart arrives on disk, not in memory.** multer `diskStorage` into `<MEETING_FILES_DIR>/tmp`, with `limits: { fileSize: MAX_MEETING_FILE_SIZE_BYTES, files: 1 }`. A 100 MB buffer per request is not acceptable; a temp file is renamed into place (same filesystem, atomic) once validation passes and unlinked otherwise. Multer's size rejection surfaces as Nest's `PayloadTooLargeException` (413) already; the plan pins the message.
7. **Upload ordering: bytes first, then one transaction.** Sniff → `fsync` → rename to `<root>/<meetingId>/<fileId>` → `$transaction`: `SELECT id FROM meetings WHERE id = $1 FOR UPDATE`, count non-deleted files, insert. Locking the meeting row serialises concurrent uploads to one meeting so the count cap cannot be raced (PRD non-functional: concurrency). If the transaction throws, the renamed file is unlinked before rethrowing. The record therefore never points at bytes that are not there, and bytes never outlive a failed record.
8. **Downloads stream through `StreamableFile`** with `Content-Type` from the record, `Content-Length` from the record's `size`, `X-Content-Type-Options: nosniff`, and `Content-Disposition` built by the `content-disposition` package (RFC 6266/5987 encoding of the original name — the one library-shaped problem here that is worth a dependency; it is already transitively present via express).
9. **Web upload uses `XMLHttpRequest`, inside `api-client.ts`.** `fetch` cannot report upload progress and the PRD asks for a percentage when the browser can give one. The XHR lives in the one boundary file, takes the token as its first argument like every guarded wrapper, and supports `AbortSignal`. It is the only non-`fetch` call in the module and is documented as such.
10. **The second protected page extracts the gate into `src/lib/use-signed-in.ts`.** The web guide says to extract on the second page and to ask whether the cookie migration should land first. Answer for this plan: no — the migration is its own change, and the hook is exactly the code it will later delete. The hook is a token read + `getMe` + 401 redirect; it is not a session provider.
11. **Module file layout** (all under `apps/api/src/modules/meeting-files/`):
    ```
    meeting-files.module.ts
    meeting-files.controller.ts
    commands/{upload-meeting-file,delete-meeting-file}.command.ts
    commands/handlers/{upload-meeting-file,delete-meeting-file}.handler.ts (+ .spec.ts)
    services/meeting-file.mapper.ts (+ .spec.ts)      record → MeetingFile, file name rules
    services/meeting-files.service.ts (+ .spec.ts)    reads: list, one, content stream
    services/meeting-file.repository.ts               claimNext, transitions, count-in-tx
    services/meeting-file-status.ts (+ .spec.ts)      the state machine
    services/content-sniffer.ts (+ .spec.ts)
    storage/meeting-file-storage.ts (+ .spec.ts)      put/open/stat/remove over one root
    storage/multipart.ts                              multer options for the controller
    processing/meeting-file-worker.ts (+ .spec.ts)    poll loop, drain(), lease
    processing/steps/{verify,preview}.step.ts (+ .spec.ts)
    processing/pipeline.ts                            the ordered step list
    ```

## Global Constraints

- **Test-first, per task, at the e2e level** — the protocol above. No implementation step in a task starts before its e2e spec has been seen red.
- **Every task ends green.** Run `pnpm test --force` for the baseline in Task 0 and `pnpm --filter=@repo/api test` plus `pnpm --filter=@repo/api test:e2e` after each API task, `pnpm --filter=@repo/web test` plus `pnpm --filter=@repo/web test:e2e` after each web task. `test:e2e` needs `docker compose up -d postgres` and a migrated schema, and it truncates `users` in whatever `DATABASE_URL` points at.
- **The existing e2e specs pass unmodified throughout.** `auth-*.e2e-spec.ts` and `meetings.e2e-spec.ts` are not touched. `GET /api/meetings` and `GET /api/meetings/:id` do not change shape (PRD F3). Each new e2e spec, once green, joins that set for every later task.
- **E2E specs compile against the pre-implementation tree.** They import nothing from `src/modules/meeting-files` and nothing generated. Table access is raw SQL in `test/utils/meeting-files-table.ts`; URLs and caps are in `test/utils/fixtures.ts`; the one runtime handle the worker spec needs is obtained by a string provider token (Task 9).
- **Contract values live in `@repo/shared` and are imported, never restated** — statuses, the size cap, the count cap, the allow-list. The e2e fixtures file restates the numeric caps on purpose (a relaxed bound must fail a test), following the existing `MAX_TITLE_LENGTH` precedent.
- **`meeting-files` does not import `MeetingsModule`.** It imports `CqrsModule` and `AuthModule` (for the guard) and dispatches `FindVisibleMeetingQuery`. `PrismaService` is allowed — this module owns its own table.
- **Prisma client is imported from `../../generated/prisma/client`** (adjust depth). Run `pnpm --filter=@repo/api prisma:generate` after the schema change or `PrismaService` will not know the model.
- **Import injectable classes as values.** `import type` only for pure types (`MeetingFile`, `Meeting`, `User`).
- **Strict TypeScript, no `any`**, including in mocks and in Playwright specs. `noUncheckedIndexedAccess` is on: index a `string[]` and handle `undefined`.
- **Exact dependency versions**, `pnpm add --save-exact`. New runtime deps for `@repo/api`: `file-type@16.5.4`, `sharp@0.34.5` (match the lockfile), `content-disposition@0.5.4`. New dev deps: `@types/multer`, `@types/content-disposition` for the API; `@playwright/test` and `pg` + `@types/pg` for the web e2e teardown. No `allowBuilds` change is needed (Playwright downloads browsers with `pnpm exec playwright install chromium`, not a lifecycle script; add that to Setup).
- **Every global in `configure-app.ts`, never `main.ts`.** Nothing in this plan needs a new global.
- **Error messages are the PRD's copy, verbatim**, where the PRD gives one: `This meeting already has 50 files.`, `That file type is not supported.`, `Processing failed. You can still download the file.` The count message interpolates `MAX_MEETING_FILES`.
- **404 for anything the caller may not see**, including a file id from another meeting and a delete by a participant who is neither uploader nor host. Never 403.
- **Logging:** every status transition logs `fileId`, `meetingId`, from, to, and duration at `log`; a failed step logs the cause with its stack at `error`. `failureReason` on the record never contains a stack or an internal path.
- **Documentation lands in the same commit as the code it describes** (Task 13 lists what; earlier tasks note the doc they owe). Both `CLAUDE.md` and `AGENTS.md` in every touched directory, verified with `diff`.
- **Conventional Commits.** Suggested scopes: `shared`, `api`, `web`, `repo`.
- **Finish with the CI order on the finished tree**: `pnpm format:check && pnpm lint && pnpm build && pnpm typecheck && pnpm test`, then `pnpm --filter=@repo/api test:e2e` and `pnpm --filter=@repo/web test:e2e`.

## File Structure

| File                                                                                                             | Responsibility                                              | Task |
| ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---- |
| `packages/shared/src/types/meeting-file.ts`, `src/index.ts`                                                      | `MeetingFile`, statuses, caps, allow-list                   | 1    |
| `apps/api/prisma/schema.prisma`, `prisma/migrations/<ts>_add_meeting_files`                                      | `MeetingFile` model and enum                                | 2    |
| `apps/api/test/utils/meeting-files-table.ts`, `test/utils/fixtures.ts`, `test/fixtures/*`                        | Raw-SQL helpers, URLs, caps, sample files                   | 2, 5 |
| `apps/api/src/config/env.validation.ts`, `.env.example`, `docker-compose.yml`, `.gitignore`, `test/setup-env.ts` | `MEETING_FILES_DIR`, `MEETING_FILES_WORKER_ENABLED`, volume | 3    |
| `apps/api/src/modules/meeting-files/storage/*`                                                                   | Filesystem storage service, multer options                  | 3, 6 |
| `apps/api/src/modules/meetings/queries/*`                                                                        | `FindVisibleMeetingQuery` + handler                         | 4    |
| `apps/api/src/modules/meeting-files/{module,controller}.ts`, `services/*`                                        | Module wiring, reads, mapper, repository, state machine     | 5–8  |
| `apps/api/src/modules/meeting-files/commands/*`                                                                  | Upload and delete commands and handlers                     | 6, 8 |
| `apps/api/src/modules/meeting-files/processing/*`                                                                | Worker, pipeline, steps                                     | 9    |
| `apps/api/test/meeting-files-{list,upload,download,delete,worker}.e2e-spec.ts`                                   | API e2e contract, one file per task                         | 5–9  |
| `apps/web/playwright.config.ts`, `apps/web/e2e/*`, `apps/api` `start:e2e-web` script                             | Browser e2e suite                                           | 10   |
| `apps/web/src/lib/api-client.ts` (+ test), `src/lib/meeting-files.ts` (+ test)                                   | Endpoint wrappers, pure helpers                             | 10   |
| `apps/web/src/lib/use-signed-in.ts`, `src/app/home-dashboard.tsx`                                                | Extracted gate; cards become links                          | 11   |
| `apps/web/src/app/meetings/[id]/page.tsx`, `meeting-page.tsx`                                                    | Meeting page shell and header                               | 11   |
| `apps/web/src/app/meetings/[id]/files/*`                                                                         | Files section: list, rows, upload, delete dialog            | 12   |
| Root, `apps/api`, `apps/web` guides; `README.md`                                                                 | Documentation                                               | 13   |

---

### Task 0: Baseline

- [ ] `docker compose up -d postgres`, then `pnpm --filter=@repo/api prisma:migrate` if the schema is not current.
- [ ] `pnpm test --force` and `pnpm --filter=@repo/api test:e2e`. Record the counts. A suite that is red now is not this plan's to fix, but it must be known.
- [ ] `pnpm build && pnpm typecheck` once, so a later failure is attributable.

### Task 1: Shared contract

**Files:** create `packages/shared/src/types/meeting-file.ts`; modify `packages/shared/src/index.ts`.

No e2e can observe a type package. The red-first check is the type layer itself.

- [ ] **Red:** in `apps/api/test/utils/fixtures.ts`, add `MAX_MEETING_FILE_SIZE_BYTES = 100 * 1024 * 1024`, `MAX_MEETING_FILES = 50`, `MAX_MEETING_FILE_NAME_LENGTH = 255` as restated numbers (the `MAX_TITLE_LENGTH` precedent) and a one-line unit test in `packages/shared` (`src/types/meeting-file.test.ts`, Vitest is not set up there — use a `tsc`-level check instead: a file `src/contract-check.ts` that asserts `MAX_MEETING_FILES === 50` via a `const _: 50 = MAX_MEETING_FILES` type assertion). Run `pnpm typecheck --filter=@repo/shared`: red on the missing module.
- [ ] Add the contract exactly as the PRD's _Contract_ section gives it: `MEETING_FILE_STATUSES`, `MeetingFileStatus`, `MeetingFile`, `MAX_MEETING_FILE_SIZE_BYTES`, `MAX_MEETING_FILES`. Add `MAX_MEETING_FILE_NAME_LENGTH = 255`.
- [ ] Define `MEETING_FILE_ALLOWED_TYPES` as a `ReadonlyArray<string>` of media types: `application/pdf`, `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `video/mp4`, `video/webm`, `audio/mpeg`, `audio/mp4` (M4A), `audio/wav`, `text/plain`, `text/markdown`, `text/csv`, and the three Office types (`application/vnd.openxmlformats-officedocument.{wordprocessingml.document,spreadsheetml.sheet,presentationml.presentation}`).
- [ ] Also export `MEETING_FILE_ACCEPT: ReadonlyArray<string>` — the extension list for the picker's `accept` attribute (`.pdf,.png,…,.docx,.xlsx,.pptx`). Media types alone are not enough for `accept` (browsers filter `text/markdown` inconsistently), and the picker list must be derived from the same file as the server's check.
- [ ] Add a comment on `audio/wav`: `file-type` reports `audio/vnd.wave` for WAV; the sniffer maps it to `audio/wav` (Task 6), so the allow-list holds the name clients expect.
- [ ] Export everything (types with `export type`, values as values) from `src/index.ts`.
- [ ] **Green:** `pnpm build --filter=@repo/shared && pnpm typecheck`. Delete `contract-check.ts` before committing — its job was the red run; the API fixtures carry the restated values from here on.
- [ ] Commit: `feat(shared): add the meeting file contract`.

### Task 2: Prisma model and migration

**Files:** modify `apps/api/prisma/schema.prisma`; create the migration; create `apps/api/test/utils/meeting-files-table.ts`.

- [ ] **Red:** write `test/utils/meeting-files-table.ts` in the style of `meetings-table.ts`: raw-SQL `findMeetingFileRows(prisma)`, `findMeetingFileRow(prisma, id)` (all columns via `to_jsonb`), `countMeetingFiles(prisma)`, `insertMeetingFileRow(prisma, row)` (for seeding caps and worker states in later specs), `setMeetingFileState(prisma, id, { status, leased_until?, attempts?, purged_at? })`. Document the expected `@@map` in its header comment as the other helpers do. Add `test/meeting-files-table.e2e-spec.ts` with one test: `countMeetingFiles` is 0 on a truncated database. Run `test:e2e`: red with `relation "meeting_files" does not exist`.
- [ ] Add the enum and model from the PRD's _Data model_, with `@map`/`@@map` on every multi-word field and the model, and with one addition: `purgedAt DateTime? @map("purged_at") @db.Timestamptz(3)` (design decision 3). Keep `size Int`, both `onDelete: Restrict`, and both indexes. Add the back-relations `files MeetingFile[]` on `Meeting` and `uploadedFiles MeetingFile[]` on `User`.
- [ ] `pnpm --filter=@repo/api prisma:migrate` with name `add_meeting_files`. Read the generated SQL; the enum must be `meeting_file_status`, the table `meeting_files`.
- [ ] `pnpm --filter=@repo/api prisma:generate`, then `pnpm build --filter=@repo/api && pnpm typecheck`.
- [ ] **Green:** `test:e2e` — the new spec passes, the old ones are unchanged, and `truncateUsers`'s `CASCADE` now covers the new table (add a second test: insert a row via `insertMeetingFileRow`, call `truncateUsers`, count is 0).
- [ ] Commit: `feat(api): add the meeting_files table`.

### Task 3: Environment and storage service

**Files:** modify `apps/api/src/config/env.validation.ts` + spec, `apps/api/.env.example`, `docker-compose.yml`, `apps/api/Dockerfile`, `.gitignore`, `apps/api/test/setup-env.ts`; create `storage/meeting-file-storage.ts` + spec, `meeting-files.module.ts`; create `test/meeting-files-boot.e2e-spec.ts`.

**Interfaces:**

- `MeetingFileStorage.put(key: string, sourcePath: string): Promise<void>` — `fsync` the source, `mkdir -p` the key's directory, `rename` into place.
- `MeetingFileStorage.openRead(key): ReadStream`; `stat(key): Promise<{ size: number }>`; `remove(key): Promise<void>` (idempotent — `ENOENT` is success); `pathOf(key): string` (for `sharp`, which wants a path); `tempDir(): string`.
- `MeetingFileStorage.onModuleInit()` creates the root and `tmp/`, then writes and unlinks a probe file. A failure throws with the resolved path in the message, which fails boot — the PRD's "checked then, not at the first upload".
- Keys are validated against `/^[0-9a-f-]{36}\/[0-9a-f-]{36}(\.thumb\.webp)?$/`. Anything else throws before touching `fs`. This is the whole path-traversal defence and it lives in one place.

- [ ] **Red:** `test/setup-env.ts` sets `process.env['MEETING_FILES_DIR'] = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-files-'))`, `MEETING_FILES_WORKER_ENABLED = 'false'`, and `process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }))`; export the directory from `fixtures.ts` as `meetingFilesDir()` (read from `process.env` at call time). Write `test/meeting-files-boot.e2e-spec.ts`: after `useApiSuite` boots the app, `<dir>/tmp` exists and is a directory. Run `test:e2e`: red — the directory does not exist because nothing creates it.
- [ ] Env: `MEETING_FILES_DIR: string` (`@IsString() @MinLength(1)`, default `storage`, resolved relative to `process.cwd()`), `MEETING_FILES_WORKER_ENABLED: boolean` (default `true`), `MEETING_FILES_LEASE_SECONDS: number` (default `60`, `@Min(5)`), `MEETING_FILES_POLL_MS: number` (default `1000`, `@Min(100)`). **Write `env.validation.spec.ts` first** with `validate({ …, MEETING_FILES_WORKER_ENABLED: 'false' })` expecting `false`: `enableImplicitConversion` may turn `'false'` into `true` (`Boolean('false')`). If it does, add an explicit `@Transform` parsing `'true'`/`'false'`/`'1'`/`'0'`.
- [ ] `.env.example`: the four variables with one-line comments. `docker-compose.yml`: `MEETING_FILES_DIR: /data/meeting-files` on `api`, a `meeting-files` named volume mounted there. The container runs as `nestjs` (uid 1001) and a fresh named volume is root-owned, so the API cannot create its root there. Fix it in the Dockerfile by declaring the directory with `RUN mkdir -p /data/meeting-files && chown nestjs:nodejs /data/meeting-files` before `USER nestjs` — Docker copies the image directory's ownership into a new named volume on first mount.
- [ ] `.gitignore`: `apps/api/storage/`.
- [ ] Unit spec for the storage service against a `mkdtemp` root: `put` moves and the source is gone; `openRead` streams the bytes; `remove` twice does not throw; a key with `..` or a leading `/` throws without creating anything; `onModuleInit` on an unwritable root (chmod 500 — skip the case on Windows) rejects with the path in the message.
- [ ] Create `MeetingFilesModule` with only `MeetingFileStorage` as a provider, import it in `AppModule`.
- [ ] **Green:** `test:e2e` (the boot spec passes; nothing else changed), `pnpm --filter=@repo/api test`. Boot the API by hand once: `apps/api/storage/tmp` appears.
- [ ] Owed docs (Task 13): the root guide's Setup and `README.md` need the storage directory and the volume.
- [ ] Commit: `feat(api): add meeting file storage and its environment`.

### Task 4: `FindVisibleMeetingQuery` in the meetings module

**Files:** create `apps/api/src/modules/meetings/queries/find-visible-meeting.query.ts`, `queries/handlers/find-visible-meeting.handler.ts` + spec; modify `meetings.module.ts`.

This is an internal read with no route, so no HTTP-level spec can be red for it alone. Its e2e coverage is Task 5's visibility cases, which are written in Task 5 and exercise this handler through the list route. Here the red-first check is the unit spec:

- [ ] **Red:** write the unit spec first, `find-visible-meeting.handler.spec.ts`: returns the mapped meeting for host, for participant, `null` for a stranger, `null` for an unknown id. Run `pnpm --filter=@repo/api test`: red on the missing module.
- [ ] `FindVisibleMeetingQuery(userId, meetingId)` resolves to `Meeting | null` — `null`, never a 404, per the API guide's query rule. The handler is `MeetingsService.findOne` minus the throw, sharing `visibleTo` and `PARTICIPANTS_INCLUDE` from the mapper.
- [ ] Do **not** reroute `MeetingsController.findOne` through the bus. The guide is explicit that in-module reads stay on the service. Two near-identical reads is the accepted cost; note in the handler's doc comment that it exists because a read crosses a module boundary.
- [ ] Register the handler in `providers`.
- [ ] **Green:** unit suite; `test:e2e` unchanged.
- [ ] Commit: `feat(api): answer FindVisibleMeetingQuery from the meetings module`.

### Task 5: Module skeleton, mapper, state machine, listing

**Files:** create `test/meeting-files-list.e2e-spec.ts`; create `meeting-files.controller.ts`, `services/meeting-file.mapper.ts` + spec, `services/meeting-file-status.ts` + spec, `services/meeting-files.service.ts` + spec, `services/meeting-file.repository.ts`; modify `meeting-files.module.ts`, `test/utils/fixtures.ts`.

**Interfaces:**

- `toMeetingFile(record): MeetingFile` — omits `storageKey`, `checksum`, `attempts`, `leasedUntil`, `deletedAt`, `purgedAt`; sets `failureReason` only when `failed`; sets `thumbnailPath` to `/meetings/${meetingId}/files/${id}/thumbnail` only when `thumbnailKey` is non-null; ISO strings for dates.
- `services/meeting-file-status.ts`: `canTransition(from, to): boolean` encoding the PRD's F7 graph plus `failed → uploaded` (retry) and `processing → uploaded` (lease expiry, which the claim query performs implicitly — model it so the spec pins it). `assertTransition` throws an `Error` naming both states. Every write that changes `status` goes through the repository's `transition(id, from, to, patch)`, which is a conditional `updateMany({ where: { id, status: from } })` and returns whether one row changed — the optimistic guard against two workers.
- `MeetingFilesService.findAll(userId, meetingId)`: dispatch `FindVisibleMeetingQuery`; `null` → `NotFoundException('Meeting not found')` (the same message the meetings module uses); else `findMany({ where: { meetingId, status: { not: 'deleted' } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })`.
- `MeetingFilesService.findOne(userId, meetingId, fileId)` — same visibility check, `findFirst({ where: { id: fileId, meetingId, status: { not: 'deleted' } } })`, 404 `'File not found'` on miss. A file id from another meeting misses on `meetingId` and is a 404.

- [ ] **Red:** `fixtures.ts` gains `meetingFilesUrl(meetingId)`, `meetingFileUrl(meetingId, fileId)`, `meetingFileContentUrl`, `meetingFileThumbnailUrl`. Write `meeting-files-list.e2e-spec.ts`: as host → `200 []`; as participant → `200 []`; as a third signed-in user → 404 with `Meeting not found`; unauthenticated → 401; a non-UUID id → 400; two rows seeded via `insertMeetingFileRow` with the same `created_at` come back with ids descending; a seeded `deleted` row is absent; the body of a seeded `failed` row carries `failureReason` and a seeded `ready` row with a `thumbnail_key` carries `thumbnailPath` and no `checksum`. Run: red — every case is `404 Cannot GET` because the route does not exist.
- [ ] Controller: `@Controller('meetings/:id/files')`, `@UseGuards(JwtAuthGuard)`, `ParseUUIDPipe({ version: '4' })` on both params, `GET /` only for now.
- [ ] Unit specs: mapper (every optional field's presence rule), state machine (a table of every from/to pair), service (visibility miss → 404, deleted filtered, order).
- [ ] Register `MeetingFilesController`, the service, the repository; import `CqrsModule`, `AuthModule`.
- [ ] **Green:** the list spec, then the whole `test:e2e` run, then the unit suite.
- [ ] Commit: `feat(api): list a meeting's files`.

### Task 6: Upload

**Files:** create `test/meeting-files-upload.e2e-spec.ts`, `test/fixtures/{sample.png,sample.pdf,sample.txt,sample.md,sample.csv,page.html,sample.docx}` (tiny, checked in; generate the PNG with `sharp` once or hand-write a 1×1); create `services/content-sniffer.ts` + spec, `storage/multipart.ts`, `commands/upload-meeting-file.command.ts`, `commands/handlers/upload-meeting-file.handler.ts` + spec; modify the controller, module, repository, `test/utils/api-suite.ts` (add `postFile(url, token, filePath, fieldName?)` and `delete(url)` — Supertest `.attach`). Add deps: `file-type@16.5.4`, `@types/multer`.

**Interfaces:**

- `ContentSniffer.sniff(path, originalName): Promise<string | null>` — `fileTypeFromFile`; map `audio/vnd.wave` → `audio/wav`, `audio/x-m4a` → `audio/mp4`; if detected and in `MEETING_FILE_ALLOWED_TYPES` return it; if detected and not, return `null`; if undetected, read the first 8 KiB, reject on a NUL byte or invalid UTF-8 (`new TextDecoder('utf-8', { fatal: true })`), then pick the text subtype by extension (decision 4) or return `null`.
- `storage/multipart.ts`: `meetingFileMulterOptions(storage): MulterOptions` — `diskStorage({ destination: storage.tempDir() })`, `limits: { fileSize: MAX_MEETING_FILE_SIZE_BYTES, files: 1, fields: 0 }`. A `fileFilter` is **not** used for type: the file must be on disk to sniff.
- `UploadMeetingFileCommand(userId, meetingId, originalName, tempPath, size)`; the handler returns `MeetingFile`. Order per decision 7. The handler always unlinks `tempPath` on any exit that did not rename it, and unlinks the final object if the transaction fails.
- Name rule in the mapper module: `normaliseFileName(raw): string | null` — trim, reject `/` and `\`, reject empty and > 255 after trimming, reject control characters. multer decodes `originalname` as latin1 in some versions; the e2e includes a UTF-8 name, and the conversion `Buffer.from(name, 'latin1').toString('utf8')` is added only if that case fails.

Rejections and messages (each pinned in the e2e):

| Case             | Status | Message                                                                 |
| ---------------- | ------ | ----------------------------------------------------------------------- |
| No `file` field  | 400    | `A file is required`                                                    |
| 0 bytes          | 400    | `The file is empty`                                                     |
| Bad name         | 400    | `The file name must be 1–255 characters and contain no path separators` |
| > 100 MB         | 413    | `Files must be 100 MB or smaller.`                                      |
| Type not allowed | 415    | `That file type is not supported.`                                      |
| 51st file        | 409    | `This meeting already has 50 files.`                                    |

Multer's own size error arrives as `PayloadTooLargeException` with `File too large`; wrap `FileInterceptor` in a thin interceptor that maps it to the PRD's copy.

- [ ] **Red:** write `meeting-files-upload.e2e-spec.ts`: happy path (PNG fixture → 201, body matches `MeetingFile` with status `uploaded`, `contentType: 'image/png'`, `size`, `uploaderId`, `createdAt` an ISO instant, no `failureReason`/`thumbnailPath`; the row exists with `storage_key = '<meetingId>/<fileId>'`; the object exists at `<meetingFilesDir()>/<meetingId>/<fileId>` with identical bytes; `<dir>/tmp` is empty); every row of the table above; `page.html` attached as `page.pdf` → 415; `page.html` attached as `notes.txt` → 201 with `text/plain`; `sample.md` → `text/markdown`, `sample.csv` → `text/csv`, `sample.docx` → the Word type; a UTF-8 name (`отчёт.pdf`) round-trips exactly; a participant may upload; a stranger → 404 `Meeting not found` and no row, no object; after two uploads the list (Task 5's route) shows them newest first. The 413 test uses `Buffer.alloc(MAX + 1)` in its own `describe` with a raised timeout — the cap is the contract. The 51st-file test seeds 50 rows via `insertMeetingFileRow`. Concurrency: seed `MAX - 1`, fire `MAX_MEETING_FILES` parallel uploads, exactly one 201, the rest 409, temp dir empty, exactly one new object on disk. For every rejection assert the temp dir is empty and the row count unchanged. Run: red — `404 Cannot POST`.
- [ ] Implement sniffer, multer options, command, handler, controller `POST /`, the size-message interceptor.
- [ ] Unit specs: sniffer (each fixture type, HTML-as-pdf → null, HTML-as-txt → `text/plain`, NUL byte → null, UTF-16 → null); handler with a mocked repository and storage (cap → 409 and the object removed; storage failure → rethrown and no record).
- [ ] **Green:** upload spec, full `test:e2e`, unit suite.
- [ ] Commit: `feat(api): upload a file to a meeting`.

### Task 7: Download and thumbnail

**Files:** create `test/meeting-files-download.e2e-spec.ts`; modify controller, `meeting-files.service.ts` + spec. Add dep `content-disposition@0.5.4` + `@types/content-disposition`.

- [ ] **Red:** write the download spec using Task 6's upload to create files: `GET content` for the PNG returns identical bytes with `content-type: image/png`, `content-length` equal to the size, `content-disposition` `attachment; filename="sample.png"`, `x-content-type-options: nosniff`, `cache-control: private, no-store`; a UTF-8 text file round-trips; a name with a quote and a non-ASCII character yields both `filename` and `filename*`; stranger → 404; another meeting's file id → 404; a row set to `failed` via `setMeetingFileState` still downloads; a row set to `deleted` → 404; unlink the object then request → 500 with an `ApiErrorResponse` body, not a hung socket (use a Supertest timeout). `GET thumbnail` → 404 `Thumbnail not found` when `thumbnail_key` is null; write a WebP beside the object and set `thumbnail_key` via SQL → `200 image/webp` inline. Run: red — `404 Cannot GET`.
- [ ] `GET :fileId/content`: service returns `{ record, stream }`; the controller sets the headers above and returns `new StreamableFile(stream)`. Any status except `deleted` (already filtered by the read).
- [ ] `GET :fileId/thumbnail`: `image/webp`, `inline` disposition, same `nosniff` and cache headers.
- [ ] **Green:** download spec, full `test:e2e`, unit suite.
- [ ] Commit: `feat(api): download a meeting file and its thumbnail`.

### Task 8: Delete

**Files:** create `test/meeting-files-delete.e2e-spec.ts`, `commands/delete-meeting-file.command.ts`, handler + spec; modify controller, module.

- [ ] **Red:** write the delete spec: uploader deletes → 204, gone from the list, `GET content` → 404, the row has `status = 'deleted'`, `deleted_at` set, `purged_at` null, `leased_until` null, **and the object still exists on disk** (purge is the worker's); host deletes a participant's file → 204; another participant → 404 `File not found` and the row unchanged (`to_jsonb` snapshot compare); stranger → 404 `Meeting not found`; deleting twice → 404; a file id from another meeting → 404. Run: red — `404 Cannot DELETE`.
- [ ] `DeleteMeetingFileCommand(userId, meetingId, fileId)`. Handler: resolve the visible meeting (404), load the non-deleted file (404), check `userId === file.uploaderId || userId === meeting.hostId` else **404**, then `transition(id, currentStatus, 'deleted', { deletedAt: now, leasedUntil: null })`. If the conditional update changed zero rows (the worker moved it meanwhile) re-read once and retry; a second miss is a 409 `'The file changed while it was being deleted; try again'`. Returns `204`.
- [ ] Unit spec for the handler: the four outcomes, the retry-once path.
- [ ] **Green:** delete spec, full `test:e2e`, unit suite.
- [ ] Commit: `feat(api): soft-delete a meeting file`.

### Task 9: Worker and pipeline

**Files:** create `test/meeting-files-worker.e2e-spec.ts`, `processing/meeting-file-worker.ts` + spec, `processing/pipeline.ts`, `processing/steps/verify.step.ts` + spec, `processing/steps/preview.step.ts` + spec; modify the repository, module, `fixtures.ts`. Add dep `sharp@0.34.5`.

**Interfaces:**

- `interface ProcessingStep { readonly name: string; run(ctx: StepContext): Promise<StepPatch> }` where `StepContext = { record, storage, logger }` and `StepPatch` is the subset of columns a step may set (`checksum`, `thumbnailKey`). `pipeline.ts` exports `PIPELINE: ReadonlyArray<ProcessingStep> = [verifyStep, previewStep]`. Adding a step is one entry here.
- `VerifyStep`: `stat` the object, throw `StepError('The stored file is incomplete')` on a size mismatch, stream through `createHash('sha256')`, return `{ checksum }`.
- `PreviewStep`: if `contentType` starts with `image/`, `sharp(path).rotate().resize(320, 320, { fit: 'inside', withoutEnlargement: true }).webp()` to `storage.pathOf(`${key}.thumb.webp`)`, return `{ thumbnailKey }`; else `{}`. A decode failure is `StepError('The image could not be read')`.
- `StepError extends Error { userMessage: string }` — the only thing that reaches `failureReason`. Any other throw stores the PRD's generic `Processing failed. You can still download the file.` and logs the real error.
- `MeetingFileRepository.claimNext(leaseSeconds): Promise<ClaimedRow | null>` — the raw `UPDATE … SKIP LOCKED` from decision 2, selecting rows where `(status = 'uploaded') OR (status = 'processing' AND leased_until < now()) OR (status = 'deleted' AND purged_at IS NULL AND (leased_until IS NULL OR leased_until < now()))`, ordered by `created_at, id`. Deleted rows are claimed without changing their status — only `leased_until` and `attempts` move. `attempts` counts claims, not failures.
- `MeetingFileWorker`: `OnApplicationBootstrap` starts a `setTimeout` loop when the flag is on; `OnApplicationShutdown` stops it and awaits the in-flight tick. `tick()`: claim; if null, sleep `POLL_MS`; if a deleted row, `storage.remove(key)`, `remove(thumbKey)`, set `purgedAt`, release the lease; else run the pipeline, then `transition(id, 'processing', 'ready', { ...patches, processedAt, leasedUntil: null })` or `transition(id, 'processing', 'failed', { failureReason, leasedUntil: null })`. A zero-row transition (deleted mid-run, or lease lost) is logged and the patch discarded. `drain(): Promise<number>` runs ticks until a claim returns null and returns how many rows it handled — the test handle. **The worker is registered under the string token `'MEETING_FILE_WORKER'` as well as its class**, so the e2e spec can `app.get<{ drain(): Promise<number> }>('MEETING_FILE_WORKER')` without importing from `src/modules/meeting-files` — which is what lets the spec compile red.
- Retry: `MAX_ATTEMPTS = 3`. A row claimed for the fourth time is not run; it is failed with `Processing failed after repeated attempts`.

- [ ] **Red:** `fixtures.ts` gains `MEETING_FILE_WORKER_TOKEN = 'MEETING_FILE_WORKER'`; `api-suite.ts` gains `app(): INestApplication`. Write the worker spec (the flag is off in `setup-env.ts`, so nothing runs unless drained): upload a PNG → `drain()` returns 1 → row `ready`, `checksum` equals the fixture's SHA-256 (compute in the test with `node:crypto`), `thumbnail_key = '<key>.thumb.webp'`, the thumbnail file exists and `GET thumbnail` returns `image/webp` with a body `sharp` is not needed to check (assert the RIFF/WEBP magic bytes), `processed_at` set, `leased_until` null, `attempts = 1`. Upload a PDF → `ready`, no thumbnail. Upload a PNG, truncate the object on disk, drain → `failed`, `failure_reason = 'The stored file is incomplete'`, `GET content` still answers 200. Set a row to `processing` with `leased_until` in the past → `drain()` claims it → `ready` (the "API died mid-file" criterion). Set `leased_until` in the future → `drain()` returns 0 and the row is untouched. Set `attempts = 3` and status `uploaded` → drain → `failed` with the repeated-attempts message. Delete a ready file (Task 8's route) → `drain()` returns 1, both objects gone, `purged_at` set; `drain()` again → 0. Two files uploaded → `drain()` returns 2 and both are `ready`. Run: red — `app.get('MEETING_FILE_WORKER')` throws "Nest could not find … element".
- [ ] Implement the repository claim, the steps, the pipeline, the worker, the flag wiring.
- [ ] Unit specs: worker with a mocked repository and steps (patch discarded when the transition reports zero rows; generic reason on a non-`StepError`; attempts cap; shutdown awaits the in-flight tick), each step against a temp file, `PIPELINE` order.
- [ ] **Green:** worker spec, full `test:e2e`, unit suite. Then a flag-on smoke check by hand: `pnpm dev`, upload with curl, watch `uploaded → processing → ready` in the log with durations.
- [ ] Owed docs (Task 13): API guide section on the worker.
- [ ] Commit: `feat(api): process uploaded meeting files`.

### Task 10: Web e2e harness, API wrappers, and pure helpers

**Files:** create `apps/web/playwright.config.ts`, `apps/web/e2e/fixtures.ts`, `apps/web/e2e/global-teardown.ts`, `apps/web/e2e/meeting-page.spec.ts`, `apps/web/e2e/meeting-files.spec.ts`; modify `apps/web/package.json`, `apps/api/package.json` (`start:e2e-web`), `apps/web/src/lib/api-client.ts` + test; create `src/lib/meeting-files.ts` + test.

This task writes **both** web e2e specs red — for Task 11 (page) and Task 12 (files section) — and turns nothing green but the unit layer. The two specs stay red until their tasks land; that is the intended state, and the checklist for Tasks 11 and 12 opens by re-running them.

- [ ] Install `@playwright/test`, `pg`, `@types/pg` (dev, exact). `pnpm exec playwright install chromium`. Config per _The web e2e suite_: `webServer` array with the API on 3101 and the web app on 3100, `baseURL: 'http://localhost:3100'`, `fullyParallel: false`, `workers: 1` (one database), `retries: 0`, trace on first retry off — a flaky test is a bug here. `globalTeardown` truncates `users` over `pg` using `DATABASE_URL` from `apps/api/.env` (read with `dotenv`, already an API dev dependency; add it to web dev deps too).
- [ ] `e2e/fixtures.ts`: `registerThroughUi(page, email)`, `createMeetingViaApi(token, { title, participantIds })` (reads the token from `localStorage` via `page.evaluate`), `uniqueEmail()`, paths to the sample files (copy the API's `test/fixtures/` set — `sample.png`, `sample.pdf`, `page.html`, `notes.txt`; a 101 MB file is generated into the OS temp dir at suite start with `fs.writeFileSync` of a sparse buffer, not checked in).
- [ ] **Red spec 1, `meeting-page.spec.ts`:** register → `/` shows the meeting card → clicking it lands on `/meetings/<id>` → header shows title, status chip `Scheduled`, the formatted time, "Hosted by you", participant count, a back link to `/`; a second user who is a participant sees "Hosted by another member"; a third user visiting the URL gets the not-found page; visiting signed-out redirects to `/auth/login`; the empty Files section shows `No files yet. Add an agenda, a deck, or a recording.` and an `Add file` button. Run: red — the card is not a link and `/meetings/<id>` is Next's 404.
- [ ] **Red spec 2, `meeting-files.spec.ts`:** upload `sample.pdf` via the `Add file` picker (`setInputFiles` on the hidden input) → a row appears with name, size, "added by you", a `Processing` chip → within 10 s the chip is gone (worker on); upload `sample.png` → thumbnail `<img>` renders (natural width > 0); the 101 MB file → the row shows `Files must be 100 MB or smaller.`, **no** request to `/files` in `page.on('request')`, Dismiss removes it; `page.html` renamed `page.pdf` → row shows `That file type is not supported.` from the server; Download → `page.waitForEvent('download')` with the suggested filename equal to the name and the saved bytes equal to the fixture; Delete as uploader → confirm dialog with the PRD copy naming the file → row gone; as host on a participant's file → Delete visible and works; as another participant → no Delete button; drop a file onto the section (`dispatchEvent('drop')` with a `DataTransfer`) → uploads; with two files in flight the requests are sequential (assert the second `POST` starts after the first response). Run: red — `Add file` not found.
- [ ] `getMeeting(token, id): Promise<Meeting>`, `listMeetingFiles(token, meetingId): Promise<ReadonlyArray<MeetingFile>>`, `deleteMeetingFile(token, meetingId, fileId): Promise<void>` (extend `apiFetch` to return `undefined` on 204; pin it), `downloadMeetingFile(token, meetingId, fileId): Promise<Blob>`, `fetchThumbnail(token, meetingId, fileId): Promise<Blob>`.
- [ ] `uploadMeetingFile(token, meetingId, file: File, { signal, onProgress }): Promise<MeetingFile>` over `XMLHttpRequest`: `FormData` with the single `file` field, `authorization` header, `upload.onprogress` → `onProgress(loaded / total)` when `lengthComputable`, `signal` → `xhr.abort()` and reject with a `DOMException('AbortError')`, non-2xx → `ApiError` through the same `extractMessage` (refactor `readErrorMessage` to accept a parsed body). Tests use a small fake `XMLHttpRequest` class — no `any`.
- [ ] `src/lib/meeting-files.ts`: `formatFileSize(bytes)`, `statusPresentation(file)` (collapsing `uploaded`/`processing`), `validateFileBeforeUpload(file): string | null` (PRD client copy; type by extension from `MEETING_FILE_ACCEPT`, since `file.type` is unreliable for Markdown and CSV), `acceptAttribute()`, `isProcessing(files)`, `sortNewestFirst(files)` with the same tie-break rationale as `latestMeetings`.
- [ ] **Green (unit only):** every helper and wrapper has a Vitest test; `pnpm --filter=@repo/web test`. Both Playwright specs are still red and that is recorded in the commit body.
- [ ] Owed docs (Task 13): web guide Tests section — the Playwright suite, how it starts both servers, that it is not in CI, and the RTL argument being unaffected.
- [ ] Commit: `test(web): add the meeting page e2e suite and file API wrappers`.

### Task 11: The gate hook and the meeting page shell

**Files:** create `src/lib/use-signed-in.ts`, `src/app/meetings/[id]/page.tsx`, `src/app/meetings/[id]/meeting-page.tsx`, `src/components/meeting-status-chip.tsx`; modify `src/app/home-dashboard.tsx`.

- [ ] **Red:** re-run `pnpm --filter=@repo/web test:e2e -- meeting-page` and confirm the failure is still the one Task 10 recorded.
- [ ] `useSignedIn(): { state: 'loading' } | { state: 'signedOut' } | { state: 'ready'; user: User; token: string } | { state: 'failed'; message: string; retry(): void }` — the token-after-mount read, `getMe`, the 401 → clear + `router.replace('/auth/login')`, the `active` flag, and the reload counter, lifted out of `HomeDashboard` unchanged in behaviour. Its doc comment restates the guide: this is the code the cookie migration deletes, and it is not a provider.
- [ ] Rewrite `HomeDashboard` on the hook, keeping `listMeetings` in the page. Meeting cards become `Link`s to `/meetings/${id}` (check `Card` composition with the `heroui-react` skill).
- [ ] `page.tsx` exports `metadata` (`'Meeting · Video Meetings'`) and renders `<MeetingPage />`. `meeting-page.tsx` reads `useParams()` (a non-UUID → `notFound()`), uses `useSignedIn`, loads `getMeeting`; 404 → `notFound()`. Header per the PRD UX: title, `MeetingStatusChip` (extracted from the dashboard), `formatMeetingTime`, "Hosted by you" / "Hosted by another member" (no user lookup endpoint exists; noted as out of scope), participant count, back link. Empty `Files` section with the PRD copy and a non-functional `Add file` button (the spec only asserts presence here).
- [ ] **Green:** `meeting-page.spec.ts` passes; `meeting-files.spec.ts` is still red, now at the first upload; Vitest suite green. Browser inspection per the web guide (both themes, narrow viewport, clean console) recorded in the commit body.
- [ ] Commit: `feat(web): add the meeting page and extract the signed-in gate`.

### Task 12: The files section

**Files:** create `src/app/meetings/[id]/files/files-section.tsx`, `file-row.tsx`, `upload-row.tsx`, `delete-file-dialog.tsx`, `use-meeting-files.ts`; modify `src/components/icons.tsx`, `src/lib/date-time.ts` + test.

- [ ] **Red:** re-run `pnpm --filter=@repo/web test:e2e -- meeting-files` and confirm it fails at the first upload step, not earlier.
- [ ] `useMeetingFiles(token, meetingId)`: list state (`loading` / `ready` / `failed` with retry), `refresh()`, and the 3 s poll: an interval only while `isProcessing(files)`, cleared when none is or on unmount, re-evaluated after every refresh.
- [ ] Upload queue in `files-section.tsx`: `{ localId, file, progress, controller, error }[]`; pick and drop feed one `enqueue(files)`; the queue runs sequentially; a success is prepended to the list, a failure stays on its row with its message; `validateFileBeforeUpload` runs first and its message lands like a server rejection; Cancel aborts and removes; Dismiss removes a failed row.
- [ ] Drop target on the section's `Card`: `dragenter`/`dragover`/`dragleave`/`drop`, visible ring while dragging, `preventDefault` on `dragover`.
- [ ] `FileRow`: thumbnail via `fetchThumbnail` → object URL (an `<img src>` cannot carry the bearer token), revoked on unmount, else a type icon; name; `formatFileSize`; "added by you / a member · relative time" (`formatRelativeTime` in `date-time.ts`, injectable formatter, tested); status chip per `statusPresentation` (`failed` → warning chip with `Tooltip` on `failureReason`; processing → chip with `Spinner`; ready → nothing); Download via `downloadMeetingFile` → object URL → programmatic `<a download>`; Delete when uploader or host.
- [ ] `DeleteFileDialog`: HeroUI `Modal`, PRD copy, danger action, in-flight and error states. Empty state and failed-load `Alert` per the PRD.
- [ ] **Green:** `meeting-files.spec.ts` passes; the whole web `test:e2e` passes; Vitest green. Run the `ui-ux-pro-max` skill on the page and section; browser inspection (both themes, narrow viewport, keyboard path Add file → dialog → Delete, clean console); record all of it in the commit body.
- [ ] Commit: `feat(web): upload, list, download, and delete meeting files`.

### Task 13: Documentation and the final gate

**Files:** root `CLAUDE.md`/`AGENTS.md`, `README.md`, `apps/api/CLAUDE.md`/`AGENTS.md`, `apps/web/CLAUDE.md`/`AGENTS.md`.

- [ ] **Root guide:** "What this is" gains the meeting-files module and the `/meetings/[id]` page in one sentence each; Setup adds `apps/api/storage/` (gitignored, created at boot), the compose volume, and `pnpm exec playwright install chromium`; "Refactoring: run the tests after every step" gains the web `test:e2e` next to the API one; the pointer list adds the PRD and this plan. `README.md`: the same setup facts and the two e2e commands.
- [ ] **API guide:** the layout tree gets `storage/` and `processing/` as directories a module may have; a new section on the meeting-files module covering what the code cannot say: the claim query and why it is raw SQL, the lease and `drain()` with the `setup-env.ts` flag and the string token that lets the e2e spec compile before the module exists, the bytes-then-transaction upload order and the meeting-row lock, `purgedAt` as the purge marker, `file-type` pinned to 16 because 17+ is ESM-only, and that backups of `MEETING_FILES_DIR` are operational. Add `FindVisibleMeetingQuery` to the boundary discussion. "Tests": `setup-env.ts` also sets the storage directory and disables the worker; `truncateUsers` cascades to `meeting_files`; the `start:e2e-web` script exists for the browser suite and must stay in step with `setup-env.ts`.
- [ ] **Web guide:** "Signed-in state" rewritten around `useSignedIn`; "API access" notes the one `XMLHttpRequest` and why; `[id]` and `e2e/` under Layout; a "load-bearing" entry for authenticated images needing an object URL; a Tests subsection for the Playwright suite (ports 3100/3101, needs Postgres, not in CI, the test-first rule from this plan stated as the house convention for new pages).
- [ ] `for d in . apps/web apps/api; do diff "$d/CLAUDE.md" "$d/AGENTS.md" || echo "drift: $d"; done` prints nothing.
- [ ] Final gate on the finished tree, in order: `pnpm format:check`, `pnpm lint`, `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm --filter=@repo/api test:e2e`, `pnpm --filter=@repo/web test:e2e`. Then walk the PRD's acceptance checklist and tick each item in the PR description, naming the e2e test that covers it.
- [ ] Commit: `docs(repo): document meeting file upload and processing`.

## Acceptance criteria → covering spec

| PRD criterion                                                       | Spec                                                    |
| ------------------------------------------------------------------- | ------------------------------------------------------- |
| 5 MB PDF upload shows Processing, then no chip within 10 s          | `apps/web/e2e/meeting-files.spec.ts`                    |
| 101 MB rejected client-side, never sent                             | `apps/web/e2e/meeting-files.spec.ts` (request listener) |
| `.html` renamed `.pdf` → 415                                        | `test/meeting-files-upload.e2e-spec.ts`, web spec       |
| 51st upload → 409 with the count message                            | `test/meeting-files-upload.e2e-spec.ts`                 |
| Non-member → 404 on every file route, including a guessed id        | list, upload, download, delete e2e specs                |
| Uploader and host see Delete; another participant does not, API 404 | `test/meeting-files-delete.e2e-spec.ts`, web spec       |
| API killed while `processing` → `ready` after restart               | `test/meeting-files-worker.e2e-spec.ts` (expired lease) |
| Downloading a `failed` file returns the original bytes              | `test/meeting-files-download.e2e-spec.ts`               |
| build → typecheck → test → test:e2e pass on the finished tree       | Task 13                                                 |

## Out of scope for these tasks (Phase 1 boundaries)

- Retry from the UI (`failed → uploaded` exists in the state machine and repository; no route calls it).
- Any display of a user's name for uploader or host beyond "you"/"a member" — needs a user lookup the API does not expose.
- Server-sent progress, chunked upload, transcription.
- Meeting deletion cascade (F11) — the worker's purge path is what it will use.
- Running either e2e suite in CI — needs a Postgres service in the workflow, which is its own change.

## Risks worth watching

- **`enableImplicitConversion` and booleans.** `MEETING_FILES_WORKER_ENABLED=false` may parse as `true`. Task 3 tests it first.
- **multer and UTF-8 filenames.** The upload spec has the case; convert only if it fails.
- **100 MB test payloads.** One in the API suite, one in the browser suite. Keep both; isolate with raised timeouts rather than lowering the cap.
- **Playwright and the worker.** The browser suite runs the worker on, so "chip disappears within 10 s" depends on `MEETING_FILES_POLL_MS`; the `start:e2e-web` script sets it to `250`.
- **Two suites, one database.** The API suite truncates `users` per test; the browser suite must never run at the same time. Document it, and keep `workers: 1` in both.
- **`sharp` on Alpine in the Dockerfile.** `node:24-alpine` needs the `linuxmusl` prebuilt binaries in the lockfile (`supportedArchitectures` in `pnpm-workspace.yaml` if the image build fails with a missing `@img/sharp-linuxmusl-*`).
