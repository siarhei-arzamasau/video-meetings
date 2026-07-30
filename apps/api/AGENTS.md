# Package guide — `@repo/api`

> **`CLAUDE.md` and `AGENTS.md` in this directory are byte-identical mirrors.** Edit one,
> then `cp CLAUDE.md AGENTS.md`; `diff CLAUDE.md AGENTS.md` must print nothing. Below,
> **"this guide"** means both files together.

The Nest.js 11 backend. Read [the root guide](../../CLAUDE.md) first for workspace-wide
commands and conventions.

## Stack

Nest.js 11 · Prisma 7 (PostgreSQL, `@prisma/adapter-pg`) · class-validator ·
`@nestjs/jwt` · `@node-rs/argon2` · Jest + Supertest.

**Password hashing is argon2id, never bcrypt.** bcrypt truncates input at 72 bytes, which
silently makes every password sharing a 72-byte prefix the same credential. An e2e test
enforces this; `@node-rs/argon2` also needs no `allowBuilds` entry, unlike native `bcrypt`.

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
  main.ts               Process bootstrap: create app, configureApp, shutdown hooks, listen
  configure-app.ts      Every global that shapes request handling
  app.module.ts         Root module — register new feature modules here
  config/               Environment contract
  common/               Cross-cutting filters and interceptors
  modules/<feature>/    One directory per feature: module, controller, service, spec
                        auth/ additionally: commands/ (command + handler per use case),
                        services/ (PasswordService, TokenService)
  generated/prisma/     Prisma client output — generated, gitignored, never edit
prisma/
  schema.prisma         Datasource, generator, and models
  migrations/           Applied migrations — never edit one that has shipped
```

`src/modules/health` is the reference shape for a feature module — controller, service,
module. Copy that. `src/modules/auth` is the place to read for DTO validation, a guard, and
database access, but **do not copy its structure**: it is deliberately CQRS
(`@nestjs/cqrs`, one command class and handler per write operation) and no other module is.
A new feature adopts CQRS only on purpose, not by imitation.

## Bootstrap behaviour (`src/configure-app.ts`)

**Every global belongs in `configureApp`, not in `main.ts`.** `main.ts` and the e2e test app
both call it, so a global added in one place cannot go missing from the other — the e2e specs
assert behaviour that only exists because of these, and would keep passing against a test app
that had quietly diverged. Only process-level concerns (`enableShutdownHooks`, `listen`) stay
in `main.ts`.

- **Global prefix `api`** — a controller at `@Controller('health')` serves `/api/health`.
- **`ValidationPipe`** with `whitelist`, `forbidNonWhitelisted`, and `transform`. Request
  bodies and queries should be class-validator DTO classes; unknown properties are rejected
  rather than silently dropped.
- **Implicit conversion is deliberately off.** With it on, class-transformer coerces a value
  into whatever the DTO property is typed as, so `{"password": 12345678}` arrives as
  `"12345678"` and passes `@IsString()` — the API would accept credentials of any JSON type.
  The cost is that a numeric query or param DTO needs an explicit `@Type(() => Number)`.
- **`HttpExceptionFilter`** and **`LoggingInterceptor`** from `src/common/`.
- **CORS reflects the requesting origin** — fine locally, must be narrowed to an allowlist
  before any public deployment.
- **Shutdown hooks** are enabled in `main.ts`, which is what lets `PrismaService` disconnect
  cleanly. Deliberately not in `configureApp`: the test harness must not install them.

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
- **`prisma generate` is not implied by editing the schema.** A model added without it
  produces `Property 'user' does not exist on type 'PrismaService'`, which reads like a
  broken import rather than a stale client.

Database work goes through `PrismaService` (injectable, owns connect/disconnect via
`OnModuleInit`/`OnModuleDestroy`), exported by `PrismaModule`.

**Columns are snake_case, models are camelCase.** Every field that is more than one word
carries a `@map`, and every model a `@@map` — `User.passwordHash` is `users.password_hash`.
The e2e helpers read those column names over raw SQL, so a mapping change breaks them
loudly rather than silently.

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

E2E specs run against the **real database**, not a mock: `test/utils/create-test-app.ts`
boots `AppModule` and `useAuthSuite` truncates the tables it touches. `test:e2e` therefore
needs `docker compose up -d postgres` and a migrated schema — without them every test fails
in `beforeEach` with `relation "..." does not exist`, which reads like a broken suite and is
really a missing database.

> **`test:e2e` truncates `users` in whatever database `DATABASE_URL` points at.** By default
> that is your development database. It is not currently a separate test database, so local
> rows you care about will not survive a run. Point `DATABASE_URL` elsewhere if that matters.

Cleanup runs at both ends, for different reasons. `beforeEach` truncates so no test inherits
another's rows — that is also what makes a run independent of the previous one, so a repeated
run cannot fail on a duplicate-email assertion. `afterAll` truncates so the last test's
fixtures are not stranded in the database; without it, what remains depends on which spec
happened to finish last.

Four things about that setup are easy to get wrong:

- **Environment must be set in `test/setup-env.ts`, not in a helper.**
  `ConfigModule.forRoot()` is evaluated when `app.module.ts` is _imported_, and it prefers
  `process.env` over the `.env` file. Anything assigned after that import — including at the
  top of `createTestApp` — is too late, so the app signs tokens with the developer's local
  `JWT_SECRET` while the specs verify with the test one. The failure looks like broken
  signing code, not like configuration. Jest `setupFiles` runs early enough.
- **`maxWorkers: 1` is load-bearing.** Jest parallelises across spec files by default, and
  every auth spec truncates the same `users` table in the same database. Run them in
  parallel and they delete each other's fixtures — a seeded `register` starts returning 409.
  Remove this only alongside per-worker database isolation.
- **`test/utils/` reads the database over raw SQL**, not through `prisma.user`, so the
  specs pin table and column names directly (`users`, snake_case). A schema whose `@@map`
  or `@map` disagrees breaks them; the file documents the mapping it expects.
- **`test/utils/jwt.ts` verifies tokens with `node:crypto` alone**, never the library the
  API signs with, so a token only `@nestjs/jwt` can read fails the assertion. It is checked
  against a signature produced by `openssl dgst -sha256 -hmac`. Do not "simplify" it into
  `JwtService`.

Neither `pnpm test` nor CI runs `test:e2e` — it is not in `turbo.json`, and CI has no
Postgres service. Run it explicitly.

## Keeping this guide current

Update it in the same commit as the change, in **both** files.
[The root guide](../../CLAUDE.md#keeping-documentation-current) covers the general rules and
what belongs at the workspace level; this guide owns what is specific to `@repo/api`.

Revisit it when:

- **Anything global in `src/configure-app.ts` changes** — the bootstrap section documents
  what is applied once so controllers do not repeat it. A new global pipe, filter,
  interceptor, or guard belongs there; so does narrowing the CORS policy, which is currently
  flagged as local-development-only and should stop being flagged once it is fixed. Re-enabling
  implicit conversion would invalidate the DTO type-rejection the auth specs assert.
- **The Prisma setup changes** — how the connection string reaches the CLI versus the
  runtime, and where the client is generated, are the parts people get wrong. Keep the
  Prisma section accurate on upgrades, and re-check it whenever `prisma.config.ts`,
  `schema.prisma`'s generator block, or `PrismaService` is touched.
- **A new cross-cutting concern appears under `src/common/`** — say what it does and
  whether it is registered globally or per-controller.
- **The module conventions shift** — `src/modules/health` is named here as the reference
  shape for a feature module. If a better exemplar replaces it, repoint the reference.
- **A second module adopts CQRS** — the auth module is currently the only one, which is why
  the layout section calls it an exception. If commands become the norm, that framing is
  wrong and the reference shape has to be re-decided rather than quietly re-pointed.
- **The auth contract changes** — the status codes, the single shared 401 message, and the
  argon2id choice are each asserted by an e2e spec. Changing one means changing its test on
  purpose, not discovering it failed.
- **The `apps/api/**` lint overrides in `.oxlintrc.json` change** — those are documented
  with their reasons because they contradict the workspace defaults.
- **The environment contract grows** — the process (class, `.env.example`, compose file) is
  documented, not the variable list, so only a change to the process needs an edit here.

Adding a feature module that follows the existing shape needs no update. Document the
shape, not each module that uses it.
