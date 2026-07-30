# video-meetings

Monorepo holding the video meetings frontend and backend.

| Package          | Path                | Stack                                                       |
| ---------------- | ------------------- | ----------------------------------------------------------- |
| `@repo/web`      | `apps/web`          | Next.js 16 (App Router), React 19, HeroUI 3, Tailwind CSS 4 |
| `@repo/api`      | `apps/api`          | Nest.js 11, Prisma 7, PostgreSQL                            |
| `@repo/shared`   | `packages/shared`   | Cross-app types and API contracts                           |
| `@repo/tsconfig` | `packages/tsconfig` | Shared TypeScript base configs                              |

Email-and-password authentication is in place (`POST /api/auth/register`,
`POST /api/auth/login`, `GET /api/auth/me`), along with the authorized meetings API
(`POST /api/meetings`, `GET /api/meetings`, `GET /api/meetings/:id`). See
[`docs/superpowers/specs/2026-07-29-video-meetings-monorepo-design.md`](docs/superpowers/specs/2026-07-29-video-meetings-monorepo-design.md)
for the design it implements.

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

docker compose up -d postgres   # PostgreSQL on :5433
pnpm --filter=@repo/api prisma:migrate   # create the schema
pnpm dev                        # web on :3000, api on :3001
```

`GET http://localhost:3001/api/health` should return `{"status":"ok",...}`.

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

| Script                              | Does                                         |
| ----------------------------------- | -------------------------------------------- |
| `pnpm dev`                          | Starts every app in watch mode via Turborepo |
| `pnpm build`                        | Builds `@repo/shared`, then both apps        |
| `pnpm typecheck`                    | `tsc --noEmit` across every package          |
| `pnpm test`                         | Vitest (web) and Jest (api)                  |
| `pnpm lint` / `pnpm lint:fix`       | Oxlint across the workspace                  |
| `pnpm format` / `pnpm format:check` | Oxfmt across the workspace                   |
| `pnpm clean`                        | Removes build output and caches              |

Scoping to one package uses Turborepo filters: `pnpm build --filter=@repo/api`.

## Layout

```
apps/
  web/       Next.js frontend
  api/       Nest.js backend
packages/
  shared/    Types shared by both apps
  tsconfig/  Base TypeScript configs
```

## Tooling

- **Oxlint + Oxfmt** replace ESLint and Prettier. A single `.oxlintrc.json` and
  `.oxfmtrc.json` at the root cover the whole tree.
- **Husky** runs `lint-staged` on commit and `commitlint` on the commit message.
  Commits follow [Conventional Commits](https://www.conventionalcommits.org/).
- **Turborepo** caches `build`, `typecheck`, and `test` across packages.

## Database

Prisma owns the schema at `apps/api/prisma/schema.prisma`. Users, meetings, and meeting
participants are mapped to `users`, `meetings`, and `meeting_participants` tables.

```bash
pnpm --filter=@repo/api prisma:generate
pnpm --filter=@repo/api prisma:migrate
```
