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
pnpm --filter=@repo/api dev              # nest start --watch on :3001, or $PORT
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
  modules/<feature>/    One directory per feature: module, controller, specs, and
                        commands/ — a command class plus its handler per write operation.
                        queries/ mirrors it where a read crosses a module boundary.
                        services/ holds collaborators the handlers share.
                        storage/ and processing/ appear where a module owns bytes on disk
                        or a background worker (meeting-files is the one that does).
  generated/prisma/     Prisma client output — generated, gitignored, never edit
prisma/
  schema.prisma         Datasource, generator, and models
  migrations/           Applied migrations — never edit one that has shipped
```

**`src/modules/auth` is the shape to copy for a new feature module.** It is CQRS — one
command class and one handler per write operation, dispatched through `@nestjs/cqrs` — and
that is the house style for anything new, not an exception. `src/modules/health` still shows
the minimum a module needs when it changes no state and reaches no database; a module with
nothing to write needs no commands.

`src/modules/meetings` is the second worked example and the one to read for a module with
both sides: `POST /meetings` is a command, while the two reads stay on a plain service.

`src/modules/user` is the third, and the one to read before splitting a module in two. It
owns the user record — the insert, the lookups, the public shape — and has no controller, no
routes, and no exports. Two modules deep in a request path talk to it entirely over the
buses; see the module boundary section below for why that is not the same as importing it.

`src/modules/meeting-files` is the fourth and the largest: two commands, a read service, a
storage service over `fs`, and a polling worker. It has its own section below because most of
what it does right is invisible in the code — ordering, locking, and a claim query that
Prisma cannot express.

## CQRS — the module pattern

Every write operation is a command object dispatched through `@nestjs/cqrs`'s `CommandBus`
to exactly one handler. `src/modules/auth` is the worked example: `register` and `login` are
commands. `src/modules/meetings` shows the mixed case — `CreateMeetingCommand` on the write,
`MeetingsService` on the reads.

**Reads inside a module do not need a bus.** The pattern earns its indirection on operations
that change state, and on reads that cross a module boundary — one class per use case, a
uniform place for the next one to land, and a handler that can be unit-tested without an HTTP
layer. Within one module, a read served straight from a controller and a service is not a
violation of the house style: `MeetingsService` is the example, and routing its two lookups
through a `QueryBus` for symmetry with `POST /meetings` would be ceremony. The test is
whether the read crosses a boundary, not whether it sits next to a write.

### Adding a command

Five things, and the middle three fail at runtime rather than compile time:

1. `commands/<name>.command.ts` — a class whose constructor takes the values the operation
   needs.
2. `commands/handlers/<name>.handler.ts` — `@CommandHandler(TheCommand)` on a class
   implementing `ICommandHandler`, with the work in `execute`.
3. **Import `CqrsModule` in the feature module.** Each module that dispatches commands
   imports it; it is not global. A module that injects `CommandBus` without importing it
   fails at startup with an unresolved-dependency error naming the controller, not the
   missing import.
4. **Register the handler in the module's `providers`.** A handler that is written,
   decorated, and never registered compiles cleanly and throws only when the route is first
   hit. The decorator does not register anything by itself.
5. **Dispatch with explicit type arguments** — `commandBus.execute<TheCommand, TResult>(…)`.
   `execute` defaults its result to `any`, and `typescript/no-explicit-any` is an error here,
   so the inferred version fails lint rather than typecheck, which reads as unrelated noise.

**Commands carry primitives, never the DTO instance.** A DTO is an HTTP-transport object
holding class-validator decorators; a handler that accepted one could not be exercised
without constructing a web-layer object, and it would silently depend on validation having
already run. The controller destructures the DTO and passes the fields.

### Adding a query

The same five things with `queries/`, `@QueryHandler`, `IQueryHandler`, and `QueryBus`
substituted — including step 5, which matters more here, because a query's result type is
where the useful information is. `src/modules/user/queries` is the worked example.

One rule of its own: **a query returns `null` for "no such row", never a `NotFoundException`.**
What a miss means belongs to the caller. `FindUserByIdQuery` returning `null` is how
`JwtAuthGuard` can answer 401 while some future controller answers 404 from the same handler;
a handler that threw would have decided for both of them.

`@nestjs/cqrs` 11 also ships `Query<TResult>` and `Command<TResult>` base classes that carry
the result type, which would make the explicit type arguments in step 5 unnecessary. Nothing
here uses them — the messages are plain classes. Adopting them is a reasonable change, but it
is one commit that converts all of them, not a second convention alongside the first.

### Where invariants live — the auth example

A handler owns its use case, and a shared service owns anything two handlers must not
implement differently. Auth shows why that split is not cosmetic: the login endpoint must
not become an account-enumeration oracle, and that guarantee is spread across two files on
purpose.

- `LoginHandler` owns the single shared failure message. Both the unknown-email and
  wrong-password paths throw the same `INVALID_CREDENTIALS` constant. Give either path its
  own message and the endpoint starts answering "does this address have an account?".
- `PasswordService` owns the timing half — `verifyDummy` spends a real argon2 verification
  against a dummy hash built at startup, so a miss costs what a hit costs. The no-account
  path in `LoginHandler` must keep calling it, and keep `await`ing it. **No test catches its
  removal**; all four login specs stay green while the defence is gone.

`CreateUserHandler` — in the user module, not auth — maps Prisma's `P2002` to the 409 that
`POST /auth/register` returns. It is keyed on the unique index failing, not on a preceding
`findUnique`: two concurrent registrations of one address both pass a read check, and only one
survives the insert. It lives with the insert because that is the only place that can answer
authoritatively, and `RegisterHandler` deliberately does not catch it on the way past — a
`try`/`catch` there would put the response for a taken address in two files.

### Reading a Prisma constraint error — the meetings trap

`CreateMeetingHandler` maps `P2003` to a 400, and getting there is less obvious than the
`P2002` case above, because **two foreign keys in that insert point at `users`**:
`meetings_host_id_fkey` and `meeting_participants_user_id_fkey`. The code alone does not say
which failed. An unknown participant is the caller's mistake; the host row vanishing is a race
between the guard's lookup and the insert, and reporting it as "a participant is not
registered" sends someone hunting a bug in a participant list that was correct.

**The constraint name is not where it looks like it should be.** With `@prisma/adapter-pg` it
arrives nested, at `meta.driverAdapterError.cause.constraint.index`, _not_ as
`meta.field_name` — that is the older non-adapter shape, and a handler written against it
compiles, reads `undefined`, and silently misclassifies every violation. Capture the real
payload before matching on it. `create-meeting.handler.spec.ts` pins the shape observed
against Postgres for exactly that reason, and the handler searches the serialised `meta`
rather than a fixed path, since the nesting is Prisma's internal shape and not a contract.

The default is deliberate and asymmetric: an unrecognised payload yields the 400. The
participant list is the overwhelmingly likelier cause, so an upgrade that moves the field
degrades to the common answer rather than turning ordinary bad requests into 500s.

`CreateMeetingHandler` also rejects a host who lists themselves as a participant. That rule
cannot live in the DTO — the DTO never sees the host, who comes from the guard — which is what
makes it a use-case invariant and the handler's to own.

### The module boundary — auth and user

`AuthModule` owns authentication (credentials, argon2, tokens, the guard) and `UserModule`
owns the user record. **Auth reaches no database at all**; `PrismaService` appears nowhere
under `src/modules/auth`, and if it reappears there, the split has been undone.

Three messages are the entire interface:

| Message                           | Carries                 | Resolves to               |
| --------------------------------- | ----------------------- | ------------------------- |
| `CreateUserCommand`               | `email`, `passwordHash` | `User`                    |
| `FindUserByIdQuery`               | `userId`                | `User \| null`            |
| `FindUserCredentialsByEmailQuery` | `email`                 | `UserCredentials \| null` |

**`AuthModule` does not import `UserModule`, and that is deliberate.** `CqrsModule`'s
`ExplorerService` scans every module in the container and registers all handlers into one set
of buses, so naming a command or query class is enough to reach its handler wherever it lives.
The buses are the decoupling. Importing the module as well would add a compile-time dependency
that buys nothing and invites the next person to inject a provider straight across the boundary.

Two rules keep the boundary honest, and neither is enforced by a type:

- **A raw password never crosses it.** `CreateUserCommand` carries a hash, because argon2 and
  the password policy are auth's. The user module could not tell a good hash from a bad one and
  should not be handed the chance to try.
- **`UserCredentials` is declared in its query file, never in `@repo/shared`.** That package is
  imported by the browser bundle. A password hash must not appear in a type the client can
  name, which is also why it is a separate query from `FindUserByIdQuery` rather than a flag on
  it: the only caller that asks for a secret is the login path, and everyone else gets a shape
  that cannot leak one. Both user-returning paths map through `toPublicUser`, so the omission
  of `passwordHash` is a property of the module rather than of each call site.

`GET /me` still reaches no handler of its own: `JwtAuthGuard` dispatches `FindUserByIdQuery`
while authenticating, `@CurrentUser` returns what it attached, and the controller does no
second read. That is one query per authenticated request, in the guard, where the lookup
already was.

### The second boundary — meetings and meeting-files

`FindVisibleMeetingQuery(userId, meetingId) → Meeting | null` is the fourth message on the
buses and the first read to cross out of `meetings`. Every file route dispatches it before
touching a file, so a stranger, a guessed id, and a missing meeting all get the same 404 from
the same place. `MeetingFilesModule` does not import `MeetingsModule` — the buses are the
boundary, exactly as with auth and user — and `MeetingsController.findOne` still reads from
`MeetingsService`, not from the handler: the in-module read stays on the service, and two
near-identical reads is the accepted price of the rule.

### What is deliberately absent

No `EventBus`, no events, no sagas anywhere yet. Commands and queries are the parts that pay
for themselves; the rest of the CQRS vocabulary is available and unused until something needs
it. Adding an event with no subscriber, or a saga with one step, buys a file to read and
nothing else.

The `QueryBus` arrived with the auth/user split and exists for exactly one reason: a read that
crosses a module boundary. It is not there to make reads symmetrical with writes — see
`MeetingsService`, which still serves two lookups from a plain service inside its own module,
and should stay that way.

`CqrsModule` is imported per feature module rather than registered globally. That keeps a
module's dependencies readable from its own `imports` array, and it is one line — the cost
of a global registration is that no module states what it actually needs. Note the asymmetry
this creates with the paragraph above: the buses behave globally at runtime while each module
still declares them, which is what lets two modules share a bus without depending on each
other.

## Meeting files (`src/modules/meeting-files`)

What the code cannot say for itself. The PRD is `docs/specs/2026-09-19-meeting-file-upload-prd.md`;
the settled design decisions are in `docs/plans/2026-09-19-meeting-file-upload-phase-1.md`.

- **Upload is bytes first, then one transaction.** Multer writes to `<MEETING_FILES_DIR>/tmp`
  (on disk, never a 100 MB buffer); the handler sniffs, `fsync`s, and `rename`s the file into
  `<meetingId>/<fileId>` (same filesystem, so atomic), and only then inserts — inside a
  transaction that first takes `SELECT … FOR UPDATE` on the meeting row and counts. That lock
  is what makes the 50-file cap safe under concurrent uploads; a read-then-write would let two
  requests both pass the count. If the insert fails the object is removed, and the temp file
  is removed on every exit that did not rename it. The record never points at bytes that are
  not there, and bytes never outlive a failed record. **The interceptor resolves the meeting
  before it reads the body.** Nest runs interceptors before pipes and the handler, so without
  that check `MeetingFileUploadInterceptor` would write up to 100 MB to the temp directory for
  a non-UUID id or a meeting the caller cannot see, then reject it; the 400 and the 404 go out
  first instead. The handler checks visibility again — a command has to be safe whatever
  dispatched it — and that second indexed read is the cost of not writing 100 MB.
- **The type is sniffed from the bytes, never the client's header.** `file-type` is pinned to
  **16.5.4** because 17+ is ESM-only and this is a CJS build; do not "upgrade" it. Text has no
  magic bytes, so an undetected file that decodes as UTF-8 with no NUL is typed by extension —
  but only among `.txt`/`.md`/`.csv`. An extension never elevates a file to a binary type,
  which is why `page.html` renamed `page.pdf` is a 415 and `page.html` renamed `notes.txt` is
  stored as `text/plain` and served as an attachment with `nosniff`.
- **Multer needs two options that look optional.** `defParamCharset: 'utf8'` — busboy decodes
  filenames as latin1 by default and `отчёт.pdf` arrives as mojibake without it — and
  `preservePath: true`, because otherwise multer takes the basename and a path separator never
  reaches the name rule that exists to reject it.
- **`claimNext` is the one raw SQL statement in the module, and it has to be.** A worker claims
  a row with a single `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)`, setting
  `status = processing`, `leased_until = now() + lease`, `attempts + 1`, in one statement. Two
  replicas cannot claim the same row, and a worker that dies leaves a row whose lease expires
  and is reclaimed. Prisma's query builder cannot express `SKIP LOCKED`. Every other status
  change goes through `MeetingFileRepository.transition(id, from, to, patch, lease?)` — a
  conditional `updateMany` on the expected `from`, and for the worker also on the
  `leased_until` its claim was given, because a reclaim after expiry keeps the status at
  `processing` and status alone cannot tell the current holder from the one it replaced. A
  caller that gets `false` back has lost a race (a delete mid-run, an expired lease another
  worker took) and discards its result rather than overwriting — including removing the
  thumbnail it wrote, which nothing else will ever find.
- **`purgedAt` is the purge marker the PRD's schema lacked.** Delete is soft; the worker
  claims `deleted` rows that are not yet purged, removes the object and the thumbnail, and sets
  `purged_at`. Without the column, "deleted rows still holding bytes" would be unknowable and
  a crash mid-`unlink` unrecoverable. The thumbnail is removed by the key `thumbnailKeyOf`
  derives, not the one on the row: a file deleted while processing is purged before the row
  has learned its key, and the thumbnail written afterwards would otherwise be orphaned.
  `attempts` counts claims, not failures; a row claimed a fourth time is failed unrun, and a
  purge claimed a fourth time is marked purged unrun with its keys at error level in the log,
  so an object the process cannot unlink is not reclaimed every lease for ever.
- **The worker is in-process, behind `MEETING_FILES_WORKER_ENABLED` (default on).** `pnpm dev`
  runs one API process and a second entry point would be a second thing to start everywhere,
  for two steps that take milliseconds. Every replica polls when it is on; switch it off per
  replica if that matters. **`test/setup-env.ts` turns it off**, and the API e2e suite drives
  it through `drain()` instead — that is what makes "the row is now ready" an assertion rather
  than a race. `drain()` is reached under the string token `MEETING_FILE_WORKER`, so the spec
  compiles (and fails) before the worker exists.
- **Failures store copy, never causes.** Only a `StepError`'s `userMessage` reaches
  `failureReason`; anything else stores `Processing failed. You can still download the file.`
  and logs the real error with its stack. Every transition logs file id, meeting id, from, to,
  and duration.
- **Downloads declare the object's real length.** `Content-Length` is the `stat` size, not the
  record's; they differ only for a truncated object, which is already `failed` with a reason,
  and declaring the record's length would turn that download into an aborted transfer instead
  of the bytes that exist. The `stat` is also the existence check, so a missing object is an
  ordinary 500 with an error body rather than headers with no body.
- **Backups of `MEETING_FILES_DIR` are operational.** The database has the records; the
  directory has the bytes; nothing here copies either anywhere.

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

`ConfigModule` is global and reads `.env.local` then `.env`. Neither overrides a variable already
in `process.env`, which is what lets the root `pnpm dev` decide `PORT` — it probes upward from the
configured value for a free one and exports the result, so `main.ts` binds a port the web app has
already been told about. Read
[the root guide](../../CLAUDE.md#pnpm-dev-picks-the-ports-before-turborepo-starts) before
"improving" that with an `EADDRINUSE` retry here: relocating the API on its own is what the
arrangement exists to prevent, because the frontend's base URL was fixed at boot and cannot
follow. Started on its own, this app takes its configured port and fails if it is busy.

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

**Neither `pnpm test` nor CI runs `test:e2e`, so a module whose only coverage is an e2e spec
is uncovered as far as CI is concerned.** Every command handler, query handler, and read
service gets a `*.spec.ts` beside it for that reason, not for a coverage number.

E2E specs run against the **real database**, not a mock: `test/utils/create-test-app.ts`
boots `AppModule` and `useApiSuite` truncates the tables it touches. `test:e2e` therefore
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
  signing code, not like configuration. Jest `setupFiles` runs early enough. The same file
  points `MEETING_FILES_DIR` at a per-run temp directory (removed at exit, so the suite never
  reads or deletes real uploads) and sets `MEETING_FILES_WORKER_ENABLED=false`. The
  `start:e2e-web` script exists for the web app's browser suite and must stay in step with it:
  the same temp-dir idea, but the worker **on** with a fast poll, because that suite watches
  the Processing chip disappear.
- **`truncateUsers` cascades to `meeting_files`** through `meetings`, so the file specs need no
  cleanup of their own; `test/utils/meeting-files-table.ts` reads and seeds that table over
  raw SQL, including the worker states (`leased_until`, `attempts`, `purged_at`) a route cannot
  produce on demand.
- **`maxWorkers: 1` is load-bearing.** Jest parallelises across spec files by default, and
  every auth spec truncates the same `users` table in the same database. Run them in
  parallel and they delete each other's fixtures — a seeded `register` starts returning 409.
  Remove this only alongside per-worker database isolation.
- **`test/utils/` reads the database over raw SQL**, not through `prisma.user`, so the
  specs pin table and column names directly (`users`, snake_case). A schema whose `@@map`
  or `@map` disagrees breaks them; the file documents the mapping it expects.
  `meetings-table.ts` is the same idea one table over, and it exists because a response is
  not evidence about what was written: asserting through the API would reuse the same
  `include` the implementation does, so a row the code never meant to write — the host
  landing in `meeting_participants` — would be invisible. It has no truncation helper on
  purpose; `truncateUsers` cascades, and a second one would be a way for the two to
  disagree about what "clean" means.
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
- **The module conventions shift** — `src/modules/auth` is named here as the shape to copy,
  `src/modules/meetings` as the command-plus-reads example, `src/modules/user` as the
  bus-only boundary, and `src/modules/health` as the no-write minimum. If a better exemplar
  replaces any of them, repoint the reference.
- **Prisma's error `meta` shape changes on an upgrade** — the meetings section names the
  exact path the constraint arrives at today and says it is not a contract. If a version
  bump moves it, the handler keeps working but the explanation stops being true, and the
  next person reads a path that no longer exists.
- **Events or sagas arrive** — the CQRS section states plainly that neither exists. The first
  one to land makes that false, and the reason it was worth adding is exactly the kind of thing
  this guide should carry. The `QueryBus` is the precedent: it was documented with the boundary
  that justified it, not merely announced.
- **A module boundary moves** — the auth/user interface is three messages, and the guide names
  them because a fourth is a decision worth seeing in review. The two unenforced rules (no raw
  password crosses, `UserCredentials` stays out of `@repo/shared`) have no test behind them, so
  the guide is the only thing carrying them.
- **The auth contract changes** — the status codes, the single shared 401 message, and the
  argon2id choice are each asserted by an e2e spec. Changing one means changing its test on
  purpose, not discovering it failed.
- **The `apps/api/**` lint overrides in `.oxlintrc.json` change** — those are documented
  with their reasons because they contradict the workspace defaults.
- **The environment contract grows** — the process (class, `.env.example`, compose file) is
  documented, not the variable list, so only a change to the process needs an edit here.

Adding a feature module that follows the existing shape needs no update. Document the
shape, not each module that uses it.

## File upload

Use this research for it: @docs/research-meeting-upload.md
