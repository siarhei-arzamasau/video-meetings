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
built in four phases whose plans are the design record for everything about it — the worker,
the storage layout, and the module's file layout in
[phase 1](docs/plans/2026-09-19-meeting-file-upload-phase-1.md)'s _Design decisions_; the
1 GiB cap, the 8 MiB chunk size, the session table, and why a completed session enters the
phase 1 pipeline unchanged in [phase 2](docs/plans/2026-09-19-meeting-file-upload-phase-2.md)'s
_Assumptions_ and _Design constraints_; retry and the transcription step in
[phase 3](docs/plans/2026-09-19-meeting-file-upload-phase-3.md); the SSE stream that replaced
the poll in [phase 4](docs/plans/2026-09-19-meeting-file-upload-phase-4.md). The technology
choices behind all four (multer, `file-type`, the lease protocol, SSE over polling) are argued
in [`docs/research-meeting-upload.md`](docs/research-meeting-upload.md). Read those before
changing that module; do not import them into a session wholesale.

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

## Code rules

These outrank whatever the existing code happens to do.

- **Every service method has explicit parameter types and an explicit `Promise<T>` return.**
- **No `console.log`** — the framework logger (`Logger` from `@nestjs/common` in the API).
- **Names say what a thing is or does.** Files `feature.type.ts` (`meetings.service.ts`);
  methods name an action (`createMeetingWithFiles`); variables name their meaning
  (`meetingId`, never `id`, `x`, `data`, `result`); enums over strings
  (`MeetingStatus.PENDING`, not `'pnd'`); constants over magic numbers (`MAX_FILE_SIZE_MB`).
- **Size limits that trigger a refactor first:** a file over 250 lines is decomposed before
  code is added to it; a method over 40 lines loses a private method; nesting deeper than
  three levels is flattened. **The limits apply to logic:** a component's JSX return counts
  as one statement, but the logic above it obeys the same 40 lines.
- **Dependencies go through the module, never the service directly**, and never in a cycle —
  check before committing. Shared types come only from `@repo/shared`.

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
the change that broke it — and when the change is to a file already over the size limit above,
the decomposition is step one. Four repository-specific things make that work:

- **`pnpm test` replays cached logs and prints `FULL TURBO`**, which looks exactly like a
  passing run because it is reporting one from earlier. Use `pnpm test --force` for a baseline
  you intend to trust — a suite that was already red is worth knowing about before its failure
  looks like yours.
- **Both runners are set to every core** (`maxWorkers: '100%'` in `apps/api/package.json` and
  `apps/web/vitest.config.ts`). Measured on an 18-core laptop, that halves the web suite and
  costs the API's about 13% — a `ts-jest` compile per worker outweighs the parallelism there,
  and no worker count beats four for it. Both were capped at four before, and
  `--maxWorkers=4` is the way back for a run on a machine that is busy with something else;
  the pre-commit hook runs this suite too. **The e2e suites stay at one worker** — that cap
  is correctness, not speed (see [the API guide](apps/api/AGENTS.md#tests)).
- **`pnpm test` is not the whole net.** Neither it nor CI runs the two `test:e2e` suites;
  [the API guide](apps/api/AGENTS.md#tests) owns what they need and why they must never run at
  the same time.
- **An adapted test is weaker evidence than an untouched one.** Unit specs change alongside the
  code they mock; what tells you behaviour survived is the suite that passed _unmodified_,
  which for a change behind an unchanged HTTP contract is `test:e2e`. So prefer steps that
  leave it untouched: add the new destination first, rewire one caller at a time.

## Setup

The steps are in [`README.md`](README.md#getting-started); `pnpm start:dev` does them all.
Three facts that bite an agent more than a human:

- **`pnpm dev` does not generate the Prisma client**, and the client is gitignored. On a
  fresh clone or after a schema change, `pnpm --filter=@repo/api prisma:generate` first.
- **The API refuses to boot** on a `JWT_SECRET` that is unset, under 32 characters, or a
  placeholder this repository has published, and — with `MEETING_FILES_TRANSCRIPTION_ENABLED`
  on — on a missing `TRANSCRIPTION_API_URL`. All are boot-time validation, not first-request
  failures. **The `.env.example` files ship `JWT_SECRET` empty on purpose**, so a fresh copy
  does not boot until someone runs `openssl rand -base64 32`; do not "fix" that by putting a
  value back.
- **`apps/api/storage/` is where uploaded bytes live** (`MEETING_FILES_DIR`, gitignored);
  the database has only the records. Everything else about uploads is in
  [the API guide](apps/api/AGENTS.md#meeting-files-srcmodulesmeeting-files), which owns it.

### Agent tooling

`.mcp.json` is committed and declares the MCP servers every collaborator gets — currently
Playwright (`npx @playwright/mcp@latest`), for driving `apps/web` in a real browser. It needs
no install step. Add one for everyone with
`claude mcp add --scope project <name> <command>`; the default local scope stays private to
you, which is where personal or credential-bearing servers belong.

`.claude/agents/` is committed for the same reason: a subagent defined there is one every
collaborator gets. There are currently three, each a reviewer for one concern:
`security-reviewer` for vulnerabilities, `performance-reviewer` for N+1 queries and similar
waste, and `test-coverage-reviewer` for untested paths and missing edge cases. The
`review-all` skill runs all three in parallel and merges their findings into one report.
Put one here only when the whole team should have it — `~/.claude/agents/` is the personal
scope, and a subagent that encodes one person's habits belongs there.

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
- **`overrides` in `pnpm-workspace.yaml` force one version on every dependant.** Each entry says
  why it exists and what retires it — read it before upgrading the package that pins the older
  version. The one there now lifts multer past what Nest 11 pins; the API guide's meeting-files
  section has what that costs.
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
