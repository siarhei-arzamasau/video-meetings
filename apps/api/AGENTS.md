# Package guide — `@repo/api`

> **`CLAUDE.md` and `AGENTS.md` in this directory are byte-identical mirrors.** Edit one,
> then `cp CLAUDE.md AGENTS.md`; `diff CLAUDE.md AGENTS.md` must print nothing. Below,
> **"this guide"** means both files together.

The Nest.js 11 backend. Read [the root guide](../../CLAUDE.md) first for workspace-wide
commands and conventions.

## Stack

Nest.js 11 · Prisma 7 (PostgreSQL, `@prisma/adapter-pg`) · class-validator ·
Jest + Supertest.

## Commands

```bash
pnpm --filter=@repo/api dev              # nest start --watch on :3001
pnpm --filter=@repo/api build            # prisma generate && nest build
pnpm --filter=@repo/api test             # jest (*.spec.ts under src/)
pnpm --filter=@repo/api test:e2e         # jest with test/jest-e2e.json
pnpm --filter=@repo/api prisma:generate
pnpm --filter=@repo/api prisma:migrate
pnpm --filter=@repo/api prisma:studio
```

## Layout

```
src/
  main.ts               Bootstrap: global prefix, CORS, pipes, filters, interceptors
  app.module.ts         Root module — register new feature modules here
  config/               Environment contract
  common/               Cross-cutting filters and interceptors
  modules/<feature>/    One directory per feature: module, controller, service, spec
  generated/prisma/     Prisma client output — generated, gitignored, never edit
prisma/
  schema.prisma         Datasource + generator; models arrive with feature work
```

`src/modules/health` is the reference shape for a new feature module.

## Bootstrap behaviour (`src/main.ts`)

Applied globally, so individual controllers do not repeat it:

- **Global prefix `api`** — a controller at `@Controller('health')` serves `/api/health`.
- **`ValidationPipe`** with `whitelist`, `forbidNonWhitelisted`, `transform`, and implicit
  conversion. Request bodies and queries should be class-validator DTO classes; unknown
  properties are rejected rather than silently dropped.
- **`HttpExceptionFilter`** and **`LoggingInterceptor`** from `src/common/`.
- **CORS reflects the requesting origin** — fine locally, must be narrowed to an allowlist
  before any public deployment.
- **Shutdown hooks enabled**, which is what lets `PrismaService` disconnect cleanly.

## Environment

Every variable the app cannot start without belongs in the `EnvironmentVariables` class in
`src/config/env.validation.ts`. Validation runs at boot, so misconfiguration fails
immediately instead of at the first request that needs it. Adding a variable means:
the class, `.env.example`, and — if it affects local Docker — `docker-compose.yml`.

`ConfigModule` is global and reads `.env.local` then `.env`.

## Prisma 7 specifics

Prisma 7 differs from earlier versions in ways that are easy to get wrong:

- The `datasource` block has **no `url`**. The CLI reads the connection string from
  `prisma.config.ts`; the runtime client receives it through the `PrismaPg` driver adapter
  constructed in `PrismaService`.
- The client is generated into `src/generated/prisma` and imported from there — not from
  `@prisma/client`. That directory is gitignored, so `prisma generate` must run before a
  build or typecheck on a clean clone (the `build` script does this).
- `prisma.config.ts` falls back to the docker-compose connection string so `generate`
  works without a `.env`. Commands that actually reach the database still need a real
  `DATABASE_URL`.

Database work goes through `PrismaService` (injectable, owns connect/disconnect via
`OnModuleInit`/`OnModuleDestroy`), exported by `PrismaModule`.

## Lint overrides that matter here

`.oxlintrc.json` relaxes two rules for `apps/api/**`:
`typescript/consistent-type-imports` is off (Nest resolves constructor dependencies from
emitted decorator metadata, which a type-only import erases), and
`typescript/no-extraneous-class` allows decorated empty classes (Nest modules). Import
injectable classes as values, not types.

## Tests

Jest, configured inline in `package.json` with `rootDir: src` and `testRegex:
.*\.spec\.ts$` — unit specs sit beside the code as `*.spec.ts`. E2E specs use
`test/jest-e2e.json` and Supertest. Not Vitest — that's the web app.

## Keeping this guide current

Update it in the same commit as the change, in **both** files.
[The root guide](../../CLAUDE.md#keeping-documentation-current) covers the general rules and
what belongs at the workspace level; this guide owns what is specific to `@repo/api`.

Revisit it when:

- **Anything global in `src/main.ts` changes** — the bootstrap section documents what is
  applied once so controllers do not repeat it. A new global pipe, filter, interceptor, or
  guard belongs there; so does narrowing the CORS policy, which is currently flagged as
  local-development-only and should stop being flagged once it is fixed.
- **The Prisma setup changes** — how the connection string reaches the CLI versus the
  runtime, and where the client is generated, are the parts people get wrong. Keep the
  Prisma section accurate on upgrades, and re-check it whenever `prisma.config.ts`,
  `schema.prisma`'s generator block, or `PrismaService` is touched.
- **The first models and migrations land** — `schema.prisma` and this file both currently
  say models do not exist yet. Both statements need removing at that point.
- **A new cross-cutting concern appears under `src/common/`** — say what it does and
  whether it is registered globally or per-controller.
- **The module conventions shift** — `src/modules/health` is named here as the reference
  shape for a feature module. If a better exemplar replaces it, repoint the reference.
- **The `apps/api/**` lint overrides in `.oxlintrc.json` change** — those are documented
  with their reasons because they contradict the workspace defaults.
- **The environment contract grows** — the process (class, `.env.example`, compose file) is
  documented, not the variable list, so only a change to the process needs an edit here.

Adding a feature module that follows the existing shape needs no update. Document the
shape, not each module that uses it.
