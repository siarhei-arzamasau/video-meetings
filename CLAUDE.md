# Repository guide — video-meetings

Guidance for coding agents working in this repository.

> **`CLAUDE.md` and `AGENTS.md` in the repository root are byte-identical mirrors.**
> Every edit to one must be applied to the other in the same commit. Verify with
> `diff CLAUDE.md AGENTS.md` — it must print nothing. Below, **"the root guide"** means
> both files together; there is no such thing as changing one of them. The guides in
> `apps/web` and `apps/api` are mirrored the same way.

## Output language

**Everything you produce is in English, whatever language the request arrives in.** Plans, code, comments, commit messages, documentation, PR descriptions, and chat replies — all English, including when the prompt, an issue, or a pasted spec in other languages. Translate rather than mirror the input language.

## What this is

`video-meetings` — a pnpm + Turborepo monorepo for a video meetings platform.

| Package          | Path                | Stack                                                       |
| ---------------- | ------------------- | ----------------------------------------------------------- |
| `@repo/web`      | `apps/web`          | Next.js 16 (App Router), React 19, HeroUI 3, Tailwind CSS 4 |
| `@repo/api`      | `apps/api`          | Nest.js 11, Prisma 7, PostgreSQL                            |
| `@repo/shared`   | `packages/shared`   | Cross-app types and API contracts                           |
| `@repo/tsconfig` | `packages/tsconfig` | Shared TypeScript base configs                              |

Email-and-password authentication and the authorized meetings API are implemented in
`apps/api` (`register`, `login`, `me`, a display name update, meeting creation, current-user
listing, and detail lookup). `apps/web` calls four of them. `/auth/register` and `/auth/login` sign up and sign in,
sharing a `src/app/auth/layout.tsx` shell — they are the worked examples of a form talking to
the API. `/` is the signed-in home: it reads `me` and the meeting list after mount, and it is
the worked example of an authorized page, gated on the client because the token lives in
`localStorage` where neither the server nor middleware can read it. (`/register` 308s to
`/auth/register`; the sign-up page lived there first.) `/meetings/[id]` is the second gated page:
the meeting's header and its files section, which uploads, lists, downloads, and deletes files
through the API's `meeting-files` module — a CQRS module over local-disk storage with an
in-process worker that verifies and thumbnails each upload. `apps/web` and `apps/api` each have
their own guide with app-specific detail, duplicated into `CLAUDE.md` + `AGENTS.md` exactly like
the root guide.

The design this implements:
[`docs/specs/2026-07-29-video-meetings-monorepo-design.md`](docs/specs/2026-07-29-video-meetings-monorepo-design.md),
with the API's authentication module since split in two by
[`docs/specs/2026-07-30-auth-user-module-split-design.md`](docs/specs/2026-07-30-auth-user-module-split-design.md)
— `auth` owns credentials and tokens, a new `user` module owns the user record, and they
interact only over the CQRS buses. Meeting file upload is specified by
[`docs/specs/2026-09-19-meeting-file-upload-prd.md`](docs/specs/2026-09-19-meeting-file-upload-prd.md)
and built in phases; phase 1 (upload, list, download, delete, verify + preview) followed
[`docs/plans/2026-09-19-meeting-file-upload-phase-1.md`](docs/plans/2026-09-19-meeting-file-upload-phase-1.md),
whose _Design decisions_ section is the design record for the worker, the storage layout, and
the module's file layout. Phase 2 (chunked, resumable upload for files over the single-request
cap) followed
[`docs/plans/2026-09-19-meeting-file-upload-phase-2.md`](docs/plans/2026-09-19-meeting-file-upload-phase-2.md),
whose _Assumptions_ and _Design constraints_ sections are the record for the 1 GiB cap, the
8 MiB chunk size, the session table, and why a completed session enters the phase 1 pipeline
unchanged.

## Commands

Run from the repository root; Turborepo fans them out.

| Command                             | Does                                                                   |
| ----------------------------------- | ---------------------------------------------------------------------- |
| `pnpm dev`                          | Every app in watch mode (web :3000, api :3001, or the next free ports) |
| `pnpm start:dev`                    | The same, after starting Postgres and applying migrations              |
| `pnpm build`                        | `@repo/shared` first, then both apps                                   |
| `pnpm typecheck`                    | `tsc --noEmit` across every package                                    |
| `pnpm test`                         | Vitest (web) and Jest (api)                                            |
| `pnpm lint` / `pnpm lint:fix`       | Oxlint across the workspace                                            |
| `pnpm format` / `pnpm format:check` | Oxfmt across the workspace                                             |
| `pnpm clean`                        | Removes build output and caches                                        |

Scope to one package with a filter: `pnpm build --filter=@repo/api`.

### `pnpm start:dev` is `pnpm dev` plus the three things a machine needs first

`scripts/start.mjs` starts the compose Postgres if nothing answers on `DATABASE_URL`'s port,
generates the Prisma client when it is missing (it is gitignored), runs `prisma migrate deploy`,
and then execs `scripts/dev.mjs`. Every step is idempotent, so on a set-up machine it costs
seconds. `--skip-db` leaves Docker alone for a Postgres that is not this compose file's.

**`pnpm dev` stays the command to use day to day**, and it stays free of setup: it is what
`start:dev` ends by running, and what CI-adjacent tooling and the Playwright config invoke.
The split is the point — `deploy` rather than `dev` for the migrations, so a script someone
runs to see the app can never generate a migration or offer to reset their database.

### `pnpm dev` picks the ports before Turborepo starts

`pnpm dev` is `scripts/dev.mjs`, not `turbo run dev`, and the indirection buys one thing: the
API's port and the web app's idea of it are decided **together, once, before either task
exists**. The script probes upward from `PORT` and `WEB_PORT` (3001 and 3000) for the first free
port each, then hands Turborepo `PORT`, `WEB_PORT`, and a matching `NEXT_PUBLIC_API_URL`. So a
port another project is holding costs you nothing — it prints `api 3002 (3001 already in use)`
and carries on.

**It cannot be moved into the apps, and an `EADDRINUSE` retry inside `main.ts` is the wrong fix.**
The browser reaches the API through `NEXT_PUBLIC_API_URL`, which Next inlines into the client
bundle as it boots. An API that relocated itself would come up healthy on a port the web app has
already been told is something else — a backend the frontend cannot see, with nothing in either
log saying so. That is a silent failure replacing a loud one.

Three consequences worth knowing:

- **A port declared in `turbo.json` is a port that reaches the tasks.** Turborepo 2 defaults to
  strict env mode, so `PORT`, `WEB_PORT`, and `NEXT_PUBLIC_API_URL` are listed on the `dev` task
  for no other reason. Dropping one there does not fail — the app silently falls back to its
  default.
- **`NEXT_PUBLIC_API_URL` is only rewritten when it is a local URL already on `PORT`.** Anything
  else — another host, another local port — is treated as deliberate and left alone, with a
  warning if it means the web app cannot reach the API that just started.
- **This is development only.** `pnpm build` bakes in whatever `NEXT_PUBLIC_API_URL` is set at
  build time, and running an app on its own (`pnpm --filter=@repo/api dev`) honours its
  configured port exactly and fails if it is busy. A deployed port is configuration, not
  something to guess.

**Ordering matters: `build` must run before `typecheck`.** `@repo/shared` has to emit its
`.d.ts` files, and Next.js generates `next-env.d.ts` and `.next/types` during its build.
CI (`.github/workflows/ci.yml`) runs format:check → lint → build → typecheck → test; match
that order when verifying work locally.

### Refactoring: run the tests after every step

**A refactor is a sequence of steps that each end green, not one change verified at the end.**
Take a baseline before touching anything, then run the tests after each step — and keep the
steps small enough that a red suite names the change that broke it. The alternative is
finishing a large rewrite and discovering only that _something_ in it is wrong, which costs
more to bisect by hand than the intermediate runs ever cost to run.

Four things make that discipline actually work here:

- **Both test runners are capped at four workers, on purpose.** Jest (`apps/api/package.json`)
  and Vitest (`apps/web/vitest.config.ts`) default to one worker per core, which on an
  18-core laptop is forty `node` processes for a suite that finishes in seconds — a visible
  stall on a machine doing anything else, and the pre-commit hook runs the same suite. Four
  keeps a run to a corner of the machine; pass `--maxWorkers` to either runner for a box
  with cores to spare. The e2e suites are already at one.
- **Take the baseline first, and make sure it is a real run.** `pnpm test` replays cached
  logs and prints `FULL TURBO` when nothing has changed, which looks exactly like a passing
  run because it is reporting one from earlier. Use `pnpm test --force` for a baseline you
  intend to trust. A suite that was already red before you started is worth knowing about
  before its failure looks like yours.
- **`pnpm test` is not the whole net for either app.** Neither it nor CI runs `test:e2e`, so
  run `pnpm --filter=@repo/api test:e2e` too — it needs `docker compose up -d postgres` and a
  migrated schema. See [the API guide](apps/api/CLAUDE.md#tests) for why that suite is where
  the real coverage of a module boundary lives. The web app has a browser suite of its own,
  `pnpm --filter=@repo/web test:e2e` (Playwright, starts the API and the web app itself on
  3100/3101), which is the contract for its pages; the two suites share one database and must
  never run at the same time.
- **Prefer the steps that leave the suite green without touching it.** When a refactor moves
  behaviour between modules, add the new destination first and rewire one caller at a time.
  Each rewiring is independently revertible, and the untouched tests stay evidence.
- **An adapted test is weaker evidence than an untouched one.** Unit specs usually have to
  change alongside the code they mock, so they cannot be the only thing you are trusting.
  The suites that pass _unmodified_ across the whole refactor — for a change behind an
  unchanged HTTP contract, that is `test:e2e` — are what tells you behaviour survived.

Run the CI order above once at the end. Passing it step by step is not the same as passing it
on the finished tree, and `build` and `typecheck` catch things no test does.

## Setup

Node 24 (`.nvmrc`), pnpm 11 (`corepack enable`), Docker for PostgreSQL.

```bash
pnpm install
cp .env.example .env
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
docker compose up -d postgres
pnpm --filter=@repo/api prisma:generate  # required: the client is gitignored, and `dev` does not generate it
pnpm --filter=@repo/api prisma:migrate   # required: the API's tables do not exist yet
pnpm exec playwright install chromium    # only for the web browser suite (test:e2e)
pnpm dev
```

Uploaded meeting files land under `apps/api/storage/` (`MEETING_FILES_DIR`, gitignored),
which the API creates and checks for writability at boot. In `docker compose`, the `api`
service mounts a named volume there instead, so a rebuilt container keeps its files.

A file of 100 MB or less is one request. A larger one — up to 1 GiB — is sent in 8 MiB chunks
through an upload session, which lives under `storage/uploads/<uploadId>/` and stays open for
`MEETING_FILE_UPLOAD_TTL_HOURS` (default 24). An abandoned session's chunks are removed by the
same worker that purges deleted files, so the only cost of walking away from an upload is disk
until it lapses.

The meeting page learns about a file's progress from `GET /api/meetings/:id/files/events`, a
Server-Sent Events stream scoped to one meeting, and falls back to its 3 second poll when the
stream cannot be opened. A stream closes itself after `MEETING_FILES_STREAM_TTL_SECONDS`
(default 300, at least 30) so a tab left open reconnects — and refetches the list — rather
than holding a connection for ever.

Transcription of audio and video is **off by default**
(`MEETING_FILES_TRANSCRIPTION_ENABLED`). Turning it on needs `TRANSCRIPTION_API_URL` — an
OpenAI-compatible `audio/transcriptions` endpoint, hosted or a self-hosted Whisper server —
optionally `TRANSCRIPTION_API_KEY`, and it bounds each request with
`TRANSCRIPTION_TIMEOUT_SECONDS` (default 600). Changing the flag is a restart, like any other
environment change; the URL is validated at boot whenever the flag is on, so the API refuses
to start rather than fail every recording.

`JWT_SECRET` must be at least 32 characters or the API refuses to boot. The `.env.example`
placeholder satisfies that for local work only.

`GET http://localhost:3001/api/health` should return `{"status":"ok",...}` — at whichever port
`pnpm dev` printed, which is 3001 unless something else already had it.

### Agent tooling

`.mcp.json` is committed and declares the MCP servers every collaborator gets — currently
Playwright (`npx @playwright/mcp@latest`), for driving `apps/web` in a real browser. It
needs no install step; `npx` fetches it on first use. Claude Code asks each person to
approve a project-scoped server once, per machine.

Add a server for everyone with `claude mcp add --scope project <name> <command>` — the
`--scope project` is the whole point, since the default local scope stays private to you.
Keep personal or credential-bearing servers out of `.mcp.json`; use local or user scope for
those.

## Conventions

- **Tooling is Oxlint + Oxfmt**, not ESLint/Prettier. One `.oxlintrc.json` and
  `.oxfmtrc.json` at the root cover the whole tree, with per-app overrides inside
  `.oxlintrc.json`. Do not add per-package lint or format configs.
- **Types shared between web and api live in `packages/shared`.** If both apps need to
  agree on a shape, it belongs there and is imported as `@repo/shared` — never duplicated.
  `packages/shared` exports types through `src/index.ts`; add new modules there. **Values
  count too, not just types** — the auth length bounds and `MEETING_STATUSES` live there
  because a rule the client restates is a rule that will one day disagree with the server,
  and it would disagree silently.
- **TypeScript is strict**, including `noUncheckedIndexedAccess`, `noUnusedLocals`, and
  `noUnusedParameters` (`packages/tsconfig/base.json`). `typescript/no-explicit-any` is an
  error. App tsconfigs extend `@repo/tsconfig/nextjs.json` or `@repo/tsconfig/nestjs.json`.
- **Conventional Commits**, enforced by commitlint via Husky. The `pre-commit` hook runs
  `lint-staged` (oxfmt and `oxlint --fix` on staged files), then `pnpm lint` and `pnpm test`
  across the workspace — a commit that fails either does not land. Both go through Turborepo's
  cache, so a second attempt after a failure only re-runs what changed. `--no-verify` skips the
  hook when you genuinely need it (a WIP commit on a scratch branch); CI runs the same checks
  regardless, so skipping only defers them.
- **New dependencies with install scripts** must be listed under `allowBuilds` in
  `pnpm-workspace.yaml`; pnpm 11 blocks lifecycle scripts otherwise.
- **Env files are gitignored** except `*.env.example`. When adding a variable, update the
  matching `.env.example` and, for the API, `apps/api/src/config/env.validation.ts`.

## Adding a package

1. Create it under `apps/` or `packages/` (both are workspace globs).
2. Name it `@repo/<name>`, `private: true`, version `0.0.0`.
3. Extend a config from `@repo/tsconfig`.
4. Give it `build`, `typecheck`, `test`, and `clean` scripts so Turborepo's task graph
   picks it up. Declare any new build output in `turbo.json`'s `outputs`.

## Keeping documentation current

Documentation is part of the change, not a follow-up. A structural change that lands
without its doc update is incomplete — treat it the way you would a failing test.

**Update in the same commit as the code.** Reviewers should see the description and the
change together, and a doc that lags by even one commit starts teaching the wrong thing.

### Every agent guide is two files

Each agent guide exists twice in its directory — `CLAUDE.md` and `AGENTS.md`, the same
content for different agent tooling. There are three pairs: the repository root, `apps/web`,
and `apps/api`. Each pair is kept byte-identical so neither copy can quietly become the
stale one.

- **Editing:** make the change in one file, then copy it over its twin —
  `cp CLAUDE.md AGENTS.md` in that directory — rather than hand-applying the same edit
  twice. Retyping is how whitespace and wording drift creeps in.
- **Verifying:** `diff CLAUDE.md AGENTS.md` must print nothing, in every directory you
  touched. Run it before committing any change to either file. All three pairs at once:
  ```bash
  for d in . apps/web apps/api; do diff "$d/CLAUDE.md" "$d/AGENTS.md" || echo "drift: $d"; done
  ```
- **Never** add a section that names one file and not the other, or write text that only
  makes sense under one of the two names. That is why the titles are neutral and these
  documents say "the root guide" or "this guide" rather than "this file".
- **A new agent guide** starts as both files, not as one with the other to follow.

If a pair ever disagrees, neither copy is authoritative — reconcile by hand against the
actual repository state, not by picking one and copying it.

### What to touch, and when

| Change                                         | Update                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| Anything at all in an agent guide              | **Both** of its `CLAUDE.md` and `AGENTS.md`, verified with `diff`        |
| Package added, removed, or renamed             | Root guide package table, `README.md` table and layout tree              |
| Root script added or its meaning changed       | Root guide and `README.md` command tables                                |
| Task graph, caching, or build ordering changed | Root guide (Commands), `README.md` (Tooling)                             |
| Lint, format, or tsconfig convention changed   | Root guide (Conventions); the app file if it is an override              |
| Env variable added or removed                  | The matching `.env.example`, plus the `apps/api` guide if it is API-side |
| Setup or local-services steps changed          | Root guide (Setup), `README.md` (Getting started)                        |
| Anything inside one app only                   | That app's guide (both files) — see its own guidance section             |

`README.md` is for humans getting the project running; the root guide is for agents
working in it. They overlap on setup and commands — when one of those changes, check both.

### What belongs in an agent guide

Favour the things that are not recoverable by reading the code: ordering constraints,
why a setting exists, which file is the single place a concern belongs, and the traps
that look like mistakes but are deliberate. Skip anything a competent reader learns
faster from the source itself — file-by-file inventories and restated type signatures go
stale silently and earn nothing.

When a documented constraint stops being true, **delete the entry**. A stale warning is
worse than no warning, because it costs someone the time to disprove it.

### Specs

`docs/specs/` holds dated design documents. They are historical records of a
decision at a point in time — do **not** edit them to match new architecture. When a
design supersedes one of them, write a new dated spec and update the root guide's pointer
to it.
