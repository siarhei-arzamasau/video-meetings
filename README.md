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
- Docker, for the local PostgreSQL instance and, if you want transcription, the local Whisper

## Getting started

```bash
pnpm install
cp .env.example .env
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local

# The examples carry no signing key on purpose. Generate one into JWT_SECRET — in
# apps/api/.env for local development, and in .env for `docker compose`.
openssl rand -base64 32

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

`pnpm dev` prints the ports it chose. Those two are preferences rather than requirements: when
something else already holds one, it moves up to the next free port and points the frontend at
wherever the API actually landed, so a leftover server from another project does not stop you.

`GET http://localhost:3001/api/health` should return `{"status":"ok",...}` — on the API port
`pnpm dev` reported.

The API will not start without a `JWT_SECRET` of at least 32 characters, and it refuses the
placeholder this repository used to ship in its examples. A signing key published in a public
repository is one anybody can mint tokens with, and it is long enough to pass the length rule,
so the length rule alone would let a deployment boot on it. `openssl rand -base64 32`.

Credential requests are rate-limited: `AUTH_RATE_LIMIT_ATTEMPTS` (default 10) per
`AUTH_RATE_LIMIT_WINDOW_SECONDS` (default 60), per client address, shared across registering,
logging in, and changing a password. The session check the web app makes on every page is
outside that budget. Behind a reverse proxy, set `TRUST_PROXY_HOPS` to the number of proxies in
front of the API: left at 0, every client arrives as the proxy and shares one budget; set higher
than the real count, a client can choose its own address and with it a fresh budget.

The host port is 5433 rather than the usual 5432, so the container does not collide with a
PostgreSQL you already run locally. To use a different one, set `POSTGRES_PORT` in `.env`
and point `DATABASE_URL` at the same port:

```bash
POSTGRES_PORT=5434
DATABASE_URL=postgresql://postgres:postgres@localhost:5434/video_meetings
```

### Transcription (optional)

Audio and video uploads can be transcribed by a Whisper `small` model running on your own
machine, so no recording and no transcript leaves it. It is off by default, and `pnpm dev` and
`pnpm start:dev` never start it. Turning it on is one command and two settings:

```bash
docker compose --profile transcription up -d whisper   # Whisper `small` on 127.0.0.1:8000
docker compose --profile transcription ps whisper      # wait for "healthy"
```

```bash
# apps/api/.env — the example already carries the URL and the model, so only the flag changes
MEETING_FILES_TRANSCRIPTION_ENABLED=true
TRANSCRIPTION_API_URL=http://localhost:8000/v1/audio/transcriptions
TRANSCRIPTION_MODEL=Systran/faster-whisper-small
```

Restart the API afterwards. An uploaded audio or video file is then ready and downloadable as
soon as its own checks pass, and is transcribed after that, on its own: `GET
/api/meetings/:id/files` reports a `transcriptionStatus` for it — `queued`, `transcribing`,
then `transcribed` or `failed` with a `transcriptionFailureReason` — and the text is served by
`GET /api/meetings/:id/files/:fileId/transcript`. A PDF or an image has no such status. The
meeting page shows it on the recording's row, changing without a reload: "Queued for
transcription", "Transcribing…", then an "Open transcript" link that opens the text in a new
tab, or "Transcription failed" with the reason — and, for the uploader and the meeting's host,
a Retry button. The API log names the model on every transcription
(`Model Systran/faster-whisper-small transcribed audio/mpeg`).

What it costs:

- **The first start needs the network** — about 0.6 GB for the image (0.9 GB on x86-64) and
  0.5 GB for the model — and is not `healthy` until the model is downloaded. The model is kept
  on a Docker volume, and every later start works with no network at all.
- **About 2 GB of memory** once the model is loaded, and up to about 5 GB while it works
  through an hour-long recording. The model is unloaded after five idle minutes.
- **About six seconds of work per minute of audio**, measured on an 18-core Apple Silicon
  laptop. `TRANSCRIPTION_TIMEOUT_SECONDS` (default 720) bounds one transcription: that is a
  one-hour recording at twice the measured rate, so raise it on a slower machine or for
  longer recordings. A transcription that outruns it is marked failed with a reason that
  names the limit; the file stays ready. It is the one failure with no Retry: the same
  recording would meet the same limit, so raise the limit and upload it again.

Port 8000 taken? Set `WHISPER_PORT` in the root `.env` and the same port in
`TRANSCRIPTION_API_URL`. `docker compose --profile transcription stop whisper` stops the
service and keeps the model. The API boots and serves uploads and downloads whether or not
Whisper is running: a recording uploaded while it is stopped is still ready and downloadable,
and only its transcription is marked failed. Once Whisper is back, the uploader or the
meeting's host queues it again with Retry on the recording's row, which sends
`POST /api/meetings/:id/files/:fileId/transcription/retry`; other participants see the failure
without the button. Restarting the API in the middle of a transcription fails nothing — the
recording goes back to `queued` and is picked up again.
Setting the flag back to `false` stops new transcriptions and keeps every status and
transcript already stored.

Under `docker compose` the `api` service finds Whisper by itself: set
`MEETING_FILES_TRANSCRIPTION_ENABLED=true` in the root `.env` and bring the stack up with
`--profile transcription`.

### Meeting digest (optional, and it sends transcripts to Anthropic)

A meeting can have a digest — a summary, the action items with whoever was named for each,
and the decisions — written by Claude from the transcripts of its recordings. It is **off by
default, because switching it on sends meeting content to a third party**: with
`MEETING_DIGEST_ENABLED=true`, the text of every transcribed recording of a meeting is sent
to Anthropic each time one of that meeting's recordings is transcribed. The transcripts are
all that is sent — no recording, file name, email address, user id, or storage path — and with
the setting off nothing is sent at all.

```bash
# apps/api/.env
MEETING_DIGEST_ENABLED=true
ANTHROPIC_AUTH_TOKEN=...          # required with the flag on: the API refuses to boot without it
```

Restart the API afterwards. A new transcript needs transcription on as well (above). The
digest is generated with no request from anyone and read with
`GET /api/meetings/:id/digest`, by the meeting's host and participants: a `status` — `queued`,
`generating`, then `ready` or `failed` with a `failureReason` — and, once one has been stored,
the `content`. The meeting page does not show it yet.

- **Every generation is a paid request**, typically under a cent and a few seconds; the API
  log has each one's duration, model, and cost, and no response carries them.
- **A digest that fails is not retried**, and fails nothing else: the recordings stay ready
  and their transcripts still open. `MEETING_DIGEST_TIMEOUT_SECONDS` (default 240) bounds one
  generation, and a meeting whose transcripts are together past about 1.7 million characters
  — some thirty hours of speech — fails as too long rather than being digested in part.
- **Setting the flag back to `false`** sends nothing more and keeps every digest already
  stored readable. Recordings transcribed while it was off get no digest when it comes back.
- **`docker compose` does not pass these two variables to its `api` service**: the digest is
  set up for an API run with `pnpm dev`.

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

The browser suite also starts a fake transcriber on 3102 and points its API at it, so neither
suite needs Whisper running.

Both truncate the `users` table in whatever `DATABASE_URL` points at, and they share it, so run
one at a time.

A third suite sends real requests to Anthropic through the Claude Agent SDK — among them the
transcripts of a made-up meeting, to check the digest Claude writes from them. It needs no
database, but it does need the network and `ANTHROPIC_AUTH_TOKEN` in `apps/api/.env.local`
or `apps/api/.env`, and a run costs a few cents:

```bash
pnpm --filter=@repo/api test:live
```

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
