# Video Meetings Monorepo — Structure Design

**Date:** 2026-07-29
**Status:** Approved
**Scope:** Repository structure only. No product features, no business logic, no UI beyond a landing placeholder.

## Goal

Stand up an empty but fully wired monorepo holding two applications — a Next.js frontend and a Nest.js backend — plus shared configuration. Every script (`dev`, `build`, `lint`, `format`, `typecheck`, `test`) must run green from a clean clone. Product work starts from here in a later cycle.

## Stack

| Concern | Choice | Version |
|---|---|---|
| Package manager | pnpm workspaces | 11.15.1 |
| Task orchestration | Turborepo | 2.10.7 |
| Frontend | Next.js, App Router, CSS Modules | 16.2.12 |
| UI runtime | React | 19.2.8 |
| Backend | Nest.js | 11.1.28 |
| ORM | Prisma | 7.9.1 |
| Language | TypeScript | 5.9.3 |
| Lint | Oxlint | 1.76.0 |
| Format | Oxfmt | 0.61.0 |
| Web tests | Vitest + jsdom | 4.1.10 |
| API tests | Jest | 30.4.2 |
| Hooks | Husky, lint-staged, commitlint | 9.1.7 / 17.2.0 / 21.2.1 |
| Node | 24.x (`.nvmrc`) | 24.18.0 |

### TypeScript version rationale

TypeScript 7.0.2 (the native port) is the current latest, but Nest.js 11 relies on
`emitDecoratorMetadata` and the surrounding ecosystem is still settling. The repo pins
**5.9.3**, which is well-tested against both Next 16 and Nest 11. Bumping later is a
single root `devDependency` change plus a CI run.

### Linting rationale

Oxlint and Oxfmt replace ESLint and Prettier for speed and a single toolchain. Trade-off
accepted deliberately: Oxlint has no `eslint-plugin-next` parity and type-aware rules are
out of scope here. `pnpm typecheck` (`tsc --noEmit` per package) is the safety net for
type-level defects.

## Repository layout

```
video-meetings/
├─ .github/
│  └─ workflows/ci.yml
├─ .husky/
│  ├─ pre-commit                  # lint-staged
│  └─ commit-msg                  # commitlint
├─ apps/
│  ├─ web/                        # @repo/web  — Next.js, port 3000
│  └─ api/                        # @repo/api  — Nest.js, port 3001
├─ packages/
│  ├─ tsconfig/                   # @repo/tsconfig
│  └─ shared/                     # @repo/shared
├─ docs/superpowers/specs/
├─ .oxlintrc.json
├─ .oxfmtrc.json
├─ .gitignore
├─ .npmrc
├─ .nvmrc
├─ .env.example
├─ commitlint.config.js
├─ docker-compose.yml
├─ package.json
├─ pnpm-workspace.yaml
├─ turbo.json
└─ README.md
```

## Units and boundaries

Each unit below has one purpose, a declared interface, and declared dependencies.

### `@repo/tsconfig`

Publishes three TypeScript base configs. No code, no build step.

- `base.json` — strict mode, ES2023 target, `moduleResolution: bundler`-agnostic common flags.
- `nextjs.json` — extends `base.json`; JSX preserve, `noEmit`, Next plugin.
- `nestjs.json` — extends `base.json`; CommonJS, decorators, `emitDecoratorMetadata`, `outDir: dist`.

**Depends on:** nothing. **Consumed by:** `apps/web`, `apps/api`, `packages/shared`.

### `@repo/shared`

Cross-cutting types and API contracts consumed by both apps. Compiled to `dist/` with
`tsc -b` so Nest (CommonJS) and Next (bundler) can both consume it without transpile
configuration in either app.

```
packages/shared/
├─ src/
│  ├─ index.ts               # public surface — re-exports only
│  └─ types/
│     ├─ meeting.ts
│     └─ user.ts
├─ package.json              # main: dist/index.js, types: dist/index.d.ts
└─ tsconfig.json             # extends @repo/tsconfig/base.json, composite: true
```

Initial contents are minimal placeholder types (`User`, `Meeting`) that both apps
reference, proving the wiring end to end. They are real, compiling types — not stubs.

**Depends on:** `@repo/tsconfig`. **Consumed by:** `apps/web`, `apps/api`.

### `apps/web` — Next.js

```
apps/web/
├─ src/
│  ├─ app/
│  │  ├─ layout.tsx
│  │  ├─ page.tsx
│  │  ├─ page.module.css
│  │  ├─ globals.css
│  │  ├─ error.tsx
│  │  └─ not-found.tsx
│  ├─ components/            # .gitkeep — populated in feature work
│  └─ lib/
│     ├─ api-client.ts       # fetch wrapper over NEXT_PUBLIC_API_URL
│     └─ api-client.test.ts
├─ public/
├─ next.config.ts            # output: 'standalone'
├─ tsconfig.json             # extends @repo/tsconfig/nextjs.json
├─ vitest.config.ts
├─ Dockerfile
├─ .env.example
└─ package.json
```

- `output: 'standalone'` keeps the production image small.
- `api-client.ts` is the single boundary to the backend; it reads
  `NEXT_PUBLIC_API_URL` (default `http://localhost:3001/api`) and returns
  `@repo/shared` types.
- One real Vitest test covers `api-client` URL construction.

**Depends on:** `@repo/shared`, `@repo/tsconfig`.

### `apps/api` — Nest.js

```
apps/api/
├─ src/
│  ├─ main.ts                        # global /api prefix, ValidationPipe, CORS, PORT
│  ├─ app.module.ts                  # ConfigModule (global) + PrismaModule + HealthModule
│  ├─ config/
│  │  └─ env.validation.ts           # startup env schema validation
│  ├─ common/
│  │  ├─ filters/http-exception.filter.ts
│  │  └─ interceptors/logging.interceptor.ts
│  └─ modules/
│     ├─ prisma/
│     │  ├─ prisma.module.ts
│     │  └─ prisma.service.ts        # onModuleInit connect / onModuleDestroy disconnect
│     └─ health/
│        ├─ health.module.ts
│        ├─ health.controller.ts     # GET /api/health
│        └─ health.controller.spec.ts
├─ prisma/
│  └─ schema.prisma                  # datasource postgres + prisma-client generator, no models
├─ test/jest-e2e.json
├─ nest-cli.json
├─ tsconfig.json                     # extends @repo/tsconfig/nestjs.json
├─ Dockerfile
├─ .env.example
└─ package.json
```

- `schema.prisma` declares the datasource and generator only. Models arrive with feature
  work; an empty model set is valid and `prisma generate` succeeds.
- `env.validation.ts` fails fast on missing `DATABASE_URL` / `PORT`.
- One real Jest test covers the health controller.

**Depends on:** `@repo/shared`, `@repo/tsconfig`.

## Task orchestration

`turbo.json` tasks:

| Task | `dependsOn` | Outputs | Cache |
|---|---|---|---|
| `build` | `["^build"]` | `.next/**` (excl. `.next/cache/**`), `dist/**` | yes |
| `typecheck` | `["^build"]` | — | yes |
| `test` | `["^build"]` | — | yes |
| `dev` | — | — | no, `persistent: true` |
| `clean` | — | — | no |

`lint`, `lint:fix`, `format`, `format:check` run at the repo root via Oxlint/Oxfmt
directly — they are not per-package Turbo tasks, since a single config covers the tree.

Root `package.json` scripts:

```
dev           turbo run dev
build         turbo run build
typecheck     turbo run typecheck
test          turbo run test
clean         turbo run clean && rm -rf node_modules/.cache .turbo
lint          oxlint
lint:fix      oxlint --fix
format        oxfmt --write
format:check  oxfmt --check
```

## Data flow

```
browser → apps/web (Next 16, :3000)
            └─ src/lib/api-client.ts  ── HTTP ──▶ apps/api (Nest 11, :3001, /api)
                                                   └─ PrismaService ──▶ postgres:5432
                       ▲                                   ▲
                       └────── @repo/shared types ─────────┘
```

Types flow one direction: `@repo/shared` is a leaf dependency both apps import. Neither
app imports the other.

## Error handling

- **API:** global `HttpExceptionFilter` normalises every error into
  `{ statusCode, message, timestamp, path }`. `ValidationPipe` (whitelist +
  `forbidNonWhitelisted`) rejects unknown payload fields with 400.
- **Startup:** `env.validation.ts` throws before the app listens if required env vars are
  missing, so misconfiguration fails at boot rather than at first request.
- **Web:** `api-client.ts` throws a typed error on non-2xx responses; `app/error.tsx` and
  `app/not-found.tsx` provide App Router boundaries.

## Testing

- `apps/web` — Vitest 4 + jsdom, one passing test on `api-client`.
- `apps/api` — Jest 30 + ts-jest, one passing test on `HealthController`; `jest-e2e.json`
  present and wired but with no e2e specs yet.
- `pnpm test` at the root runs both through Turbo.

Coverage thresholds are deliberately not enforced yet — there is nothing meaningful to
cover until feature work lands.

## Tooling and CI

**Git hooks**
- `pre-commit` → `lint-staged`: `oxfmt --write` then `oxlint --fix` on staged
  `*.{js,jsx,ts,tsx,json,css,md}`.
- `commit-msg` → `commitlint` with `@commitlint/config-conventional`.

**GitHub Actions** (`.github/workflows/ci.yml`), on push and pull request:
`checkout → pnpm/action-setup → setup-node 24 with pnpm cache → pnpm install --frozen-lockfile → format:check → lint → typecheck → build → test`.

**Docker**
- `apps/web/Dockerfile` — multi-stage, produces a Next standalone runner image.
- `apps/api/Dockerfile` — multi-stage, `prisma generate` in the build stage, `node dist/main` at runtime.
- `docker-compose.yml` — `postgres:17-alpine` (named volume, healthcheck), `api` (depends on healthy postgres), `web` (depends on api).

## Environment variables

| Variable | Scope | Example |
|---|---|---|
| `DATABASE_URL` | api | `postgresql://postgres:postgres@localhost:5432/video_meetings` |
| `PORT` | api | `3001` |
| `NODE_ENV` | both | `development` |
| `NEXT_PUBLIC_API_URL` | web | `http://localhost:3001/api` |

Committed as `.env.example` at the root and in each app. Real `.env` files are gitignored.

## Out of scope

Authentication, WebRTC/media handling, signalling, database models, UI component library,
state management, deployment targets, observability. All deferred to later cycles.

## Acceptance criteria

From a clean clone with `pnpm install`:

1. `pnpm build` succeeds for `@repo/shared`, `apps/api`, `apps/web`.
2. `pnpm typecheck` reports zero errors.
3. `pnpm lint` and `pnpm format:check` pass with zero violations.
4. `pnpm test` passes — one web test, one api test, no skipped specs.
5. `pnpm dev` starts both apps; `http://localhost:3000` renders and
   `http://localhost:3001/api/health` returns 200.
6. No file contains a `TODO`, placeholder stub, `test.skip`, or `test.only`.
7. `docker compose config` validates.
