# Repository guide — video-meetings

Guidance for coding agents working in this repository.

> **`AGENTS.md` is the guide; `CLAUDE.md` beside it imports it.** Write every change here.
> Below, **"the root guide"** means this file; `apps/web` and `apps/api` work the same way.

## Output language

**Everything you produce is in English, whatever language the request arrives in** — plans,
code, comments, commit messages, documentation, PR descriptions, and chat replies. Translate
rather than mirror the input language.

## What this is

`video-meetings` — a pnpm + Turborepo monorepo for a video meetings platform.

| Package          | Path                | Stack                                                       |
| ---------------- | ------------------- | ----------------------------------------------------------- |
| `@repo/web`      | `apps/web`          | Next.js 16 (App Router), React 19, HeroUI 3, Tailwind CSS 4 |
| `@repo/api`      | `apps/api`          | Nest.js 11, Prisma 7, PostgreSQL                            |
| `@repo/shared`   | `packages/shared`   | Cross-app types and API contracts                           |
| `@repo/tsconfig` | `packages/tsconfig` | Shared TypeScript base configs                              |

`apps/api` owns email-and-password authentication, meetings, and meeting files; `apps/web`
is its client. Two things are worth knowing before reading either: **pages are gated on the
client**, because the token lives in `localStorage` where neither the server nor middleware
can read it, and **`meeting-files` is the largest module** — CQRS over local-disk storage
with an in-process worker. Each app has its own `AGENTS.md` with the detail.

The design this implements:
[`docs/specs/2026-07-29-video-meetings-monorepo-design.md`](docs/specs/2026-07-29-video-meetings-monorepo-design.md),
with authentication since split in two by
[`docs/specs/2026-07-30-auth-user-module-split-design.md`](docs/specs/2026-07-30-auth-user-module-split-design.md)
— `auth` owns credentials and tokens, `user` owns the user record, and they interact only
over the CQRS buses. Meeting file upload is
[`docs/specs/2026-09-19-meeting-file-upload-prd.md`](docs/specs/2026-09-19-meeting-file-upload-prd.md),
built in two phases whose plans are the design record for everything about it — the worker,
the storage layout, and the module's file layout in
[phase 1](docs/plans/2026-09-19-meeting-file-upload-phase-1.md)'s _Design decisions_; the
1 GiB cap, the 8 MiB chunk size, the session table, and why a completed session enters the
phase 1 pipeline unchanged in [phase 2](docs/plans/2026-09-19-meeting-file-upload-phase-2.md)'s
_Assumptions_ and _Design constraints_. Read those before changing that module.

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

**Ordering matters: `build` must run before `typecheck`.** `@repo/shared` has to emit its
`.d.ts` files, and Next.js generates `next-env.d.ts` and `.next/types` during its build.
CI (`.github/workflows/ci.yml`) runs format:check → lint → build → typecheck → test; match
that order when verifying work locally, and run it once on the finished tree — `build` and
`typecheck` catch things no test does.

## Token economy

Command output lands in an agent's context, so default to the narrow form of each. Widen
only when the narrow one genuinely did not answer the question.

- **`git diff --unified=0`** — likewise `git show` and `git diff --staged`.
- **`git log --oneline -10`** — reach further back only when the answer is not in the last ten.
- **`gh issue list --json number,title`** — same for `gh pr list`.
- **`pnpm test --output-logs=errors-only`** — a passing run has nothing to read. This is a
  Turborepo flag: `--silent` is npm's and `turbo` rejects it, while `pnpm test -- --silent`
  quietens Jest and Vitest but still prints every task's header.
- **`pnpm typecheck 2>&1 | tail -5`** — same for `build` and `lint`; the error is at the end.
- **`sed -n '<from>,<to>p'`** over a file whose region you already know, rather than printing
  the whole thing.

## `pnpm start:dev` is `pnpm dev` plus the three things a machine needs first

`scripts/start.mjs` starts the compose Postgres if nothing answers on `DATABASE_URL`'s port,
generates the Prisma client when it is missing (it is gitignored), runs `prisma migrate deploy`,
and then execs `scripts/dev.mjs`. Every step is idempotent, so on a set-up machine it costs
seconds. `--skip-db` leaves Docker alone for a Postgres that is not this compose file's.

**`pnpm dev` stays the command to use day to day**, and it stays free of setup: it is what
`start:dev` ends by running, and what CI-adjacent tooling and the Playwright config invoke.
The split is the point — `deploy` rather than `dev` for the migrations, so a script someone
runs to see the app can never generate a migration or offer to reset their database.

## `pnpm dev` picks the ports before Turborepo starts

`pnpm dev` is `scripts/dev.mjs`, not `turbo run dev`, and the indirection buys one thing: the
API's port and the web app's idea of it are decided **together, once, before either task
exists**. The script probes upward from `PORT` and `WEB_PORT` (3001 and 3000) for the first
free port each, then hands Turborepo `PORT`, `WEB_PORT`, and a matching `NEXT_PUBLIC_API_URL`,
printing `api 3002 (3001 already in use)` when it has to move.

**It cannot be moved into the apps, and an `EADDRINUSE` retry inside `main.ts` is the wrong fix.**
The browser reaches the API through `NEXT_PUBLIC_API_URL`, which Next inlines into the client
bundle as it boots. An API that relocated itself would come up healthy on a port the web app has
already been told is something else — a backend the frontend cannot see, with nothing in either
log saying so. That is a silent failure replacing a loud one.

- **A port declared in `turbo.json` is a port that reaches the tasks.** Turborepo 2 defaults to
  strict env mode, which is why `PORT`, `WEB_PORT`, and `NEXT_PUBLIC_API_URL` are listed on the
  `dev` task. Dropping one does not fail — the app silently falls back to its default.
- **`NEXT_PUBLIC_API_URL` is only rewritten when it is a local URL already on `PORT`.** Anything
  else is treated as deliberate and left alone, with a warning if the web app cannot then reach
  the API that just started.
- **This is development only.** `pnpm build` bakes in whatever `NEXT_PUBLIC_API_URL` is set at
  build time, and a single app (`pnpm --filter=@repo/api dev`) takes its configured port and
  fails if it is busy. A deployed port is configuration, not something to guess.

## Refactoring: run the tests after every step

**A refactor is a sequence of steps that each end green, not one change verified at the end.**
Take a baseline first, then run the tests after each step, small enough that a red suite names
the change that broke it. Four repository-specific things make that work:

- **`pnpm test` replays cached logs and prints `FULL TURBO`**, which looks exactly like a
  passing run because it is reporting one from earlier. Use `pnpm test --force` for a baseline
  you intend to trust — a suite that was already red is worth knowing about before its failure
  looks like yours.
- **Both runners are capped at four workers on purpose** (`apps/api/package.json`,
  `apps/web/vitest.config.ts`). The default of one per core is forty `node` processes on an
  18-core laptop for a suite that finishes in seconds, and the pre-commit hook runs it too.
  Pass `--maxWorkers` for a box with cores to spare; the e2e suites are already at one.
- **`pnpm test` is not the whole net.** Neither it nor CI runs `test:e2e`. Run
  `pnpm --filter=@repo/api test:e2e` (needs `docker compose up -d postgres` and a migrated
  schema; see [the API guide](apps/api/AGENTS.md#tests)) and `pnpm --filter=@repo/web test:e2e`
  (Playwright, starts both servers on 3100/3101). **The two share one database and must never
  run at the same time.**
- **An adapted test is weaker evidence than an untouched one.** Unit specs change alongside the
  code they mock; what tells you behaviour survived is the suite that passed _unmodified_,
  which for a change behind an unchanged HTTP contract is `test:e2e`. So prefer steps that
  leave it untouched: add the new destination first, rewire one caller at a time.

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

`GET http://localhost:3001/api/health` should return `{"status":"ok",...}` — at whichever port
`pnpm dev` printed.

Three environment facts that bite outside the API guide:

- **Uploaded files land under `apps/api/storage/`** (`MEETING_FILES_DIR`, gitignored), created
  and checked for writability at boot. `docker compose` mounts a named volume there instead, so
  a rebuilt container keeps its files. Backups of that directory are operational.
- **`JWT_SECRET` must be at least 32 characters** or the API refuses to boot. The
  `.env.example` placeholder satisfies that for local work only.
- **Transcription is off by default** (`MEETING_FILES_TRANSCRIPTION_ENABLED`). Turning it on
  needs `TRANSCRIPTION_API_URL`, an OpenAI-compatible `audio/transcriptions` endpoint, which
  is validated at boot so the API refuses to start rather than fail every recording.

Everything else about uploads — the 100 MB single-request cap, the 1 GiB chunked one, session
expiry, and the SSE stream the meeting page follows — is in
[the API guide](apps/api/AGENTS.md#meeting-files-srcmodulesmeeting-files), which owns it.

### Agent tooling

`.mcp.json` is committed and declares the MCP servers every collaborator gets — currently
Playwright (`npx @playwright/mcp@latest`), for driving `apps/web` in a real browser. It needs
no install step. Add one for everyone with
`claude mcp add --scope project <name> <command>`; the default local scope stays private to
you, which is where personal or credential-bearing servers belong.

## Conventions

- **Tooling is Oxlint + Oxfmt**, not ESLint/Prettier. One `.oxlintrc.json` and
  `.oxfmtrc.json` at the root cover the whole tree, with per-app overrides inside
  `.oxlintrc.json`. Do not add per-package lint or format configs.
- **Types shared between web and api live in `packages/shared`**, imported as `@repo/shared`
  and never duplicated; they are exported through `src/index.ts`. **Values count too** — the
  auth length bounds and `MEETING_STATUSES` live there because a rule the client restates is
  a rule that will one day disagree with the server, and silently.
- **TypeScript is strict**, including `noUncheckedIndexedAccess`, `noUnusedLocals`, and
  `noUnusedParameters` (`packages/tsconfig/base.json`). `typescript/no-explicit-any` is an
  error. App tsconfigs extend `@repo/tsconfig/nextjs.json` or `@repo/tsconfig/nestjs.json`.
- **Conventional Commits**, enforced by commitlint via Husky. The `pre-commit` hook runs
  `lint-staged` (oxfmt and `oxlint --fix` on staged files), then `pnpm lint` and `pnpm test`
  across the workspace; both go through Turborepo's cache, so a second attempt only re-runs
  what changed. `--no-verify` defers these checks to CI rather than skipping them.
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

**Documentation is part of the change: update it in the same commit as the code**, the way you
would a failing test. A doc that lags by even one commit starts teaching the wrong thing.

Each of the three guides — root, `apps/web`, `apps/api` — is an `AGENTS.md`. The `CLAUDE.md`
beside it is one line of prose plus an `@AGENTS.md` import, for tooling that looks for that
name; it holds no content, so there is nothing to keep in step. Keep the import bare
(inside backticks it is read as text, not followed), link between guides by their `AGENTS.md`
path, and start a new guide as that pair.

| Change                                         | Update                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| Anything at all in an agent guide              | That guide's `AGENTS.md` (never its `CLAUDE.md` pointer)                 |
| Package added, removed, or renamed             | Root guide package table, `README.md` table and layout tree              |
| Root script added or its meaning changed       | Root guide and `README.md` command tables                                |
| Task graph, caching, or build ordering changed | Root guide (Commands), `README.md` (Tooling)                             |
| Lint, format, or tsconfig convention changed   | Root guide (Conventions); the app file if it is an override              |
| Env variable added or removed                  | The matching `.env.example`, plus the `apps/api` guide if it is API-side |
| Setup or local-services steps changed          | Root guide (Setup), `README.md` (Getting started)                        |
| Anything inside one app only                   | That app's `AGENTS.md`                                                   |

`README.md` is for humans getting the project running; the root guide is for agents working
in it. They overlap on setup and commands — when one of those changes, check both.

**What belongs in a guide:** ordering constraints, why a setting exists, which file is the
single place a concern belongs, and the traps that look like mistakes but are deliberate.
Not file-by-file inventories, restated type signatures, or a list of the routes that exist
today — those go stale silently and a reader gets them faster from the source. Document the
pattern, not each instance of it. **When a documented constraint stops being true, delete
the entry**: a stale warning costs someone the time to disprove it.

`docs/specs/` holds dated design documents. They are historical records — do **not** edit them
to match new architecture. When a design supersedes one, write a new dated spec and repoint
the root guide at it.
