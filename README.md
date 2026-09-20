# video-meetings

Monorepo holding the video meetings frontend and backend.

| Package          | Path                | Stack                                                       |
| ---------------- | ------------------- | ----------------------------------------------------------- |
| `@repo/web`      | `apps/web`          | Next.js 16 (App Router), React 19, HeroUI 3, Tailwind CSS 4 |
| `@repo/api`      | `apps/api`          | Nest.js 11, Prisma 7, PostgreSQL                            |
| `@repo/shared`   | `packages/shared`   | Cross-app types and API contracts                           |
| `@repo/tsconfig` | `packages/tsconfig` | Shared TypeScript base configs                              |

The API covers email-and-password authentication, user profiles, meetings, and meeting files
(upload, chunked upload, processing, transcription, and a live status stream). The design it
implements is
[`docs/specs/2026-07-29-video-meetings-monorepo-design.md`](docs/specs/2026-07-29-video-meetings-monorepo-design.md);
later specs and plans under `docs/` build on it.

## Requirements

- Node.js 24 (`.nvmrc`)
- pnpm 11 (`corepack enable`)
- Docker, for the local PostgreSQL instance

## Getting started

```bash
pnpm install
cp .env.example .env
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local

pnpm start:dev                  # Postgres, Prisma client, migrations, then both apps
```

`pnpm start:dev` is the one-command version. The steps it wraps, if you would rather run them
yourself:

```bash
docker compose up -d postgres   # PostgreSQL on :5433
pnpm --filter=@repo/api prisma:generate  # generate the client (gitignored; `dev` does not do it)
pnpm --filter=@repo/api prisma:migrate   # create the schema
pnpm dev                        # web on :3000, api on :3001
```

Files uploaded to a meeting are stored under `apps/api/storage/` (gitignored, created at
boot; set `MEETING_FILES_DIR` to move it). Under `docker compose` the API keeps them on a named
volume instead. Files up to 100 MB are uploaded in one request; larger ones, up to 1 GB, are
uploaded in chunks and can be resumed, and an unfinished upload is discarded after
`MEETING_FILE_UPLOAD_TTL_HOURS` (default 24).

A meeting page follows its files live over Server-Sent Events and falls back to polling when
the stream cannot be opened; a stream closes after `MEETING_FILES_STREAM_TTL_SECONDS`
(default 300) and the page reconnects.

Transcription of audio and video is off by default; turning on
`MEETING_FILES_TRANSCRIPTION_ENABLED` needs `TRANSCRIPTION_API_URL` (an OpenAI-compatible
`audio/transcriptions` endpoint), optionally `TRANSCRIPTION_API_KEY`, and bounds each request
with `TRANSCRIPTION_TIMEOUT_SECONDS`.

`pnpm dev` prints the ports it chose. Those two are preferences rather than requirements: when
something else already holds one, it moves up to the next free port and points the frontend at
wherever the API actually landed, so a leftover server from another project does not stop you.

`GET http://localhost:3001/api/health` should return `{"status":"ok",...}` — on the API port
`pnpm dev` reported.

The API will not start without a `JWT_SECRET` of at least 32 characters. The copied
`.env.example` carries a placeholder that satisfies it; replace it with
`openssl rand -base64 32` before the app is reachable by anyone else.

The host port is 5433 rather than the usual 5432, so the container does not collide with a
PostgreSQL you already run locally. To use a different one, set `POSTGRES_PORT` in `.env`
and point `DATABASE_URL` at the same port:

```bash
POSTGRES_PORT=5434
DATABASE_URL=postgresql://postgres:postgres@localhost:5434/video_meetings
```

## Scripts

Run from the repository root:

| Script                              | Does                                                    |
| ----------------------------------- | ------------------------------------------------------- |
| `pnpm dev`                          | Starts every app in watch mode, on the first free ports |
| `pnpm start:dev`                    | The same, after starting Postgres and migrating it      |
| `pnpm build`                        | Builds `@repo/shared`, then both apps                   |
| `pnpm typecheck`                    | `tsc --noEmit` across every package                     |
| `pnpm test`                         | Vitest (web) and Jest (api)                             |
| `pnpm lint` / `pnpm lint:fix`       | Oxlint across the workspace                             |
| `pnpm format` / `pnpm format:check` | Oxfmt across the workspace                              |
| `pnpm clean`                        | Removes build output and caches                         |

Scoping to one package uses Turborepo filters: `pnpm build --filter=@repo/api`.

Two end-to-end suites are not part of `pnpm test` because they need PostgreSQL running:

```bash
pnpm --filter=@repo/api test:e2e        # Jest + Supertest against the real database
pnpm exec playwright install chromium   # once
pnpm --filter=@repo/web test:e2e        # Playwright; starts the API and the web app on 3101/3100
```

Both truncate the `users` table in whatever `DATABASE_URL` points at, and they share it, so run
one at a time.

## Layout

```
apps/
  web/       Next.js frontend
  api/       Nest.js backend
packages/
  shared/    Types shared by both apps
  tsconfig/  Base TypeScript configs
scripts/
  dev.mjs    Resolves dev ports, then runs Turborepo
  start.mjs  Postgres, Prisma client, migrations, then dev.mjs
docs/
  specs/     Dated design documents (historical records)
  plans/     Implementation plans per spec
```

## Tooling

- **Oxlint + Oxfmt** replace ESLint and Prettier. A single `.oxlintrc.json` and
  `.oxfmtrc.json` at the root cover the whole tree.
- **Husky** runs `lint-staged`, `pnpm lint`, and `pnpm test` on commit, and `commitlint` on
  the commit message. Commits follow
  [Conventional Commits](https://www.conventionalcommits.org/).
- **Turborepo** caches `build`, `typecheck`, and `test` across packages.

## Database

Prisma owns the schema at `apps/api/prisma/schema.prisma`; models are camelCase and map to
snake_case tables.

```bash
pnpm --filter=@repo/api prisma:generate
pnpm --filter=@repo/api prisma:migrate
```
