# Package guide — `@repo/api`

> **`AGENTS.md` is the guide; `CLAUDE.md` beside it imports it.** Write every change here.

The Nest.js 11 backend. Read [the root guide](../../AGENTS.md) first for workspace-wide
commands and conventions.

## Commands

The root scripts apply with `--filter=@repo/api`; `build` here is `prisma generate && nest build`.
This package's own:

```bash
pnpm --filter=@repo/api test:e2e         # jest with test/jest-e2e.json — see Tests
pnpm --filter=@repo/api test:watch
pnpm --filter=@repo/api prisma:generate
pnpm --filter=@repo/api prisma:migrate   # prisma migrate dev
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

Four worked examples, in the order worth reading them:

- **`auth`** — the shape to copy for a new feature module. CQRS, one command class and one
  handler per write, and that is the house style for anything new, not an exception.
- **`meetings`** — the mixed case: `POST /meetings` is a command, the two reads stay on a
  plain service.
- **`user`** — read before splitting a module in two. It owns the user record and exports
  nothing; two modules deep in a request path talk to it entirely over the buses.
- **`meeting-files`** — the largest: two commands, a read service, a storage service over
  `fs`, and a polling worker. It has its own section below because most of what it does
  right is invisible in the code.

`health` still shows the minimum a module needs when it changes no state and reaches no
database; a module with nothing to write needs no commands.

## CQRS — the module pattern

Every write is a command object dispatched through `@nestjs/cqrs`'s `CommandBus` to exactly
one handler.

**Reads inside a module do not need a bus.** The indirection earns its keep on operations that
change state, and on reads that cross a module boundary. Within one module a read served
straight from a controller and a service is not a violation of the house style —
`MeetingsService` is the example, and routing its two lookups through a `QueryBus` for
symmetry with `POST /meetings` would be ceremony. The test is whether the read crosses a
boundary, not whether it sits next to a write. **Nothing else from `@nestjs/cqrs` is used**:
no sagas, and no events beyond the one in-process `EventBus` the file worker publishes on
(see _Events and the SSE stream_). `CqrsModule` is imported per feature module, never
globally, so a module's dependencies stay readable from its own `imports` array; the buses
still behave globally at runtime, which is what lets two modules share one without depending
on each other.

### Adding a command

Five things, and the middle three fail at runtime rather than compile time:

1. `commands/<name>.command.ts` — a class whose constructor takes the values the operation
   needs.
2. `commands/handlers/<name>.handler.ts` — `@CommandHandler(TheCommand)` on a class
   implementing `ICommandHandler`, with the work in `execute`.
3. **Import `CqrsModule` in the feature module.** It is not global. A module that injects
   `CommandBus` without importing it fails at startup with an unresolved-dependency error
   naming the controller, not the missing import.
4. **Register the handler in the module's `providers`.** A handler that is written,
   decorated, and never registered compiles cleanly and throws only when the route is first
   hit. The decorator registers nothing by itself.
5. **Dispatch with explicit type arguments** — `commandBus.execute<TheCommand, TResult>(…)`.
   `execute` defaults its result to `any`, and `typescript/no-explicit-any` is an error here,
   so the inferred version fails lint rather than typecheck, which reads as unrelated noise.

**Commands carry primitives, never the DTO instance.** A DTO is an HTTP-transport object
holding class-validator decorators; a handler that accepted one could not be exercised without
constructing a web-layer object, and would silently depend on validation having already run.
The controller destructures the DTO and passes the fields.

### Adding a query

The same five things with `queries/`, `@QueryHandler`, `IQueryHandler`, and `QueryBus`
substituted — step 5 matters more here, because a query's result type is where the useful
information is. `src/modules/user/queries` is the worked example.

One rule of its own: **a query returns `null` for "no such row", never a `NotFoundException`.**
What a miss means belongs to the caller. `FindUserByIdQuery` returning `null` is how
`JwtAuthGuard` answers 401 while some future controller answers 404 from the same handler.

`@nestjs/cqrs` 11 ships `Query<TResult>`/`Command<TResult>` base classes that would make step
5's type arguments unnecessary. Nothing here uses them; adopting them is one commit that
converts all of them, not a second convention alongside the first.

### Where invariants live — the auth example

A handler owns its use case; a shared service owns anything two handlers must not implement
differently. `PasswordService` is the example: **hashing is argon2id (`@node-rs/argon2`),
never bcrypt** — bcrypt truncates input at 72 bytes, which silently makes every password
sharing a 72-byte prefix the same credential; an e2e test enforces this. Its cost parameters
are stated there too — OWASP's 19 MiB, two passes, one lane — although they are the library's
native defaults: its own typings document 4 MiB and three passes, which is enough to mislead
a review, and a default can move under a version bump. Login must not become
an account-enumeration oracle either, and that guarantee is split across two files on purpose:

- `LoginHandler` owns the single shared failure message — both the unknown-email and
  wrong-password paths throw the same `INVALID_CREDENTIALS` constant. Give either its own
  message and the endpoint starts answering "does this address have an account?".
- `PasswordService` owns the timing half — `verifyDummy` spends a real argon2 verification
  against a dummy hash built at startup by `hash` itself, so it carries a stored hash's
  parameters and a miss costs what a hit costs. The no-account path
  must keep calling it, and keep `await`ing it. **No test catches its removal**; all four login
  specs stay green while the defence is gone.

`CreateUserHandler` — in the user module, not auth — maps Prisma's `P2002` to the 409 that
`POST /auth/register` returns. It is keyed on the unique index failing, not a preceding
`findUnique`: two concurrent registrations of one address both pass a read check and only one
survives the insert. `RegisterHandler` deliberately does not catch it on the way past — a
`try`/`catch` there would put the response for a taken address in two files.

### Reading a Prisma constraint error — the meetings trap

`CreateMeetingHandler` maps `P2003` to a 400, and that is less obvious than the `P2002` case,
because **two foreign keys in that insert point at `users`**: `meetings_host_id_fkey` and
`meeting_participants_user_id_fkey`. An unknown participant is the caller's mistake; the host
row vanishing is a race between the guard's lookup and the insert, and reporting it as "a
participant is not registered" sends someone hunting a bug in a correct participant list.

**The constraint name is not where it looks like it should be.** With `@prisma/adapter-pg` it
arrives at `meta.driverAdapterError.cause.constraint.index`, _not_ `meta.field_name` — the
older non-adapter shape, against which a handler compiles, reads `undefined`, and silently
misclassifies every violation. `create-meeting.handler.spec.ts` pins the payload observed
against Postgres, and the handler searches the serialised `meta` rather than a fixed path,
since the nesting is Prisma's internal shape and not a contract. The default is deliberately
asymmetric: an unrecognised payload yields the 400, the overwhelmingly likelier cause, so an
upgrade that moves the field degrades to the common answer rather than turning ordinary bad
requests into 500s.

The handler also rejects a host who lists themselves as a participant. That rule cannot live
in the DTO — the DTO never sees the host, who comes from the guard — which is what makes it a
use-case invariant and the handler's to own.

### The module boundary — auth and user

`AuthModule` owns authentication (credentials, argon2, tokens, the guard) and `UserModule`
owns the user record. **Auth reaches no database at all**; `PrismaService` appears nowhere
under `src/modules/auth`, and if it reappears there, the split has been undone.

Five messages are the entire interface:

| Message                           | Carries                  | Resolves to               |
| --------------------------------- | ------------------------ | ------------------------- |
| `CreateUserCommand`               | `email`, `passwordHash`  | `User`                    |
| `UpdatePasswordHashCommand`       | `userId`, `passwordHash` | `void`                    |
| `FindUserByIdQuery`               | `userId`                 | `User \| null`            |
| `FindUserCredentialsByEmailQuery` | `email`                  | `UserCredentials \| null` |
| `FindUserCredentialsByIdQuery`    | `userId`                 | `UserCredentials \| null` |

**`AuthModule` does not import `UserModule`, and that is deliberate.** `CqrsModule`'s
`ExplorerService` registers every handler in the container into one set of buses, so naming a
command or query class reaches its handler wherever it lives. The buses are the decoupling;
importing the module as well would add a compile-time dependency that buys nothing and invites
the next person to inject a provider straight across the boundary.

Two rules keep it honest, and no type enforces either:

- **A raw password never crosses it.** `CreateUserCommand` and `UpdatePasswordHashCommand`
  both carry a hash, because argon2 and the password policy are auth's. The user module could
  not tell a good hash from a bad one. `ChangePasswordCommand` does carry raw passwords — and
  it is an auth-module command dispatched from an auth-module controller, so it never crosses
  anything.
- **`UserCredentials` is declared beside the two queries that return it
  (`queries/user-credentials.ts`), never in `@repo/shared`**, which the browser bundle
  imports. That is also why they are separate queries from `FindUserByIdQuery` rather than a
  flag on it: only the credential paths ask for a secret, and everyone else gets a shape that
  cannot leak one. Both user-returning paths map through `toPublicUser`, so omitting
  `passwordHash` is a property of the module rather than of each call site.
- **Two credential queries, by email and by id, because two paths need one.** Login knows an
  address; a password change knows the token's subject and nothing else. Asking by email there
  would mean auth holding a user's address in order to verify their password.

`GET /me` reaches no handler of its own: `JwtAuthGuard` dispatches `FindUserByIdQuery` while
authenticating and `@CurrentUser` returns what it attached — one query per authenticated
request, in the guard, where the lookup already was.

### The display name — registration derives it, the user owns it

`PATCH /api/users/me` (`UserController` → `UpdateDisplayNameCommand`) is the user module's
first route. `UserModule` imports `AuthModule` for `JwtAuthGuard` as the meetings modules do;
the dependency runs that way and never the other, so the bus-only boundary is untouched.

- **Registration derives the initial name and nothing else overwrites it.**
  `displayNameFromEmail` runs in `CreateUserHandler` and is the only place that ever writes a
  name the user did not choose. A profile sync that "refreshes" it from the address would
  silently undo a name someone set.
- **The endpoint acts on the caller and nobody else.** `me` is a literal segment, not a
  parameter, so the rule is a property of the routing table rather than a check each new
  handler must remember. An `id` in the body is a 400 from `forbidNonWhitelisted`, not a field
  quietly dropped; `test/users-me.e2e-spec.ts` asserts both, including that
  `PATCH /api/users/<id>` is a 404.

The trim-and-bounds rule is stated twice, in `UpdateDisplayNameDto` and in the handler, and
that is not redundancy to remove: the DTO is the HTTP layer's rejection, carrying the one
message `@repo/shared` exports so a field that turns red in the browser says exactly what the
server would, while the handler is the use case's own invariant, because **a command has to be
safe whatever dispatched it**. **Both measure through `isDisplayNameWithinBounds` from
`@repo/shared`** — the web form calls it too — which trims _before_ measuring, so
whitespace-only fails the minimum without a rule of its own, and counts code points. Do not
swap the DTO's custom decorator back to `@Length`: validator.js counts surrogate pairs as one
and variation selectors as none, the handler once counted UTF-16 units, and a name the DTO
accepted came back from the handler as a 400 calling it too long. One decorator covers both
bounds so a non-string is told the sentence once, not once per bound.

### Changing a password — `PATCH /api/auth/password`

In `auth`, not `user`, because this module owns credentials: it verifies the old one,
applies the policy to the new one, hashes it, and hands `user` a hash. 204, because there is
nothing to answer with.

**A wrong current password is a 401 carrying `CURRENT_PASSWORD_MESSAGE`, and that constant is
load-bearing.** The status is login's, so the endpoint reveals no more than login does — but
the browser already reads a 401 as "the token went bad, sign out", and a user who mistypes
their current password must get a field error rather than be signed out. The two 401s on this
route are told apart by **that exact sentence**, which is why it lives in `@repo/shared` and
is imported by both sides. The guard's own 401 carries Nest's bare `Unauthorized`.
`auth-change-password.e2e-spec.ts` asserts the two messages differ; if they ever converge, a
typo logs the user out.

**The order of checks in `ChangePasswordHandler` is a security property, not tidiness.** The
new password's bounds are checked first (not a secret — the caller typed it and the DTO
already refused it once), then the current password, and only then whether the new one equals
it. Asking "is this actually a change?" before verifying would tell someone holding a stolen
token whether a guessed password is the account's current one.

**The PRD's "rate-limited the same way login is, if login is" resolves to one budget for the
three credential routes.** `AuthController` carries `@UseGuards(ThrottlerGuard)` at class
level, so a route added to it is limited by default and has to opt out on purpose — `me` is
the only one that does, because the web app calls it to gate every page and would otherwise
spend a budget meant for password attempts. Four things about it are worth knowing before
changing it:

- **The key deliberately ignores the handler** (`auth-throttle.options.ts`). The throttler's
  default counts per route, which would hand register, login, and the password change an
  allowance each — three times the stated limit, collectable by rotating endpoints.
- **The budget is also a cost limit, not only an anti-guessing one.** Every login attempt
  spends a full argon2id verification even when no account matches, because `LoginHandler`
  hashes a dummy on the miss path to close the timing oracle. Unlimited, that turns a stream
  of tiny unauthenticated POSTs into memory-hard work on the libuv threadpool.
- **The tracker is `req.ip`, and `TRUST_PROXY_HOPS` decides what that is.** At the default of
  zero it is the socket address and `X-Forwarded-For` is ignored — correct, because a
  header-derived key is one the caller chooses. Behind a reverse proxy that default puts every
  client on the proxy's single budget, so a deployment that terminates TLS elsewhere sets the
  hop count to the number of proxies in front — **exactly**: one too many and an address the
  caller wrote becomes its key, a fresh budget per request.
- **Storage is in-process**, so replicas do not share a counter and N replicas mean N times the
  limit. A scaled-out deployment wants a shared store.

`auth-rate-limit.e2e-spec.ts` pins all of it, and does it by overriding the throttler's
options provider with `authThrottlerOptions(...)` at a budget a test can spend — the run's own
limit (`test/setup-env.ts`, and `start:e2e-web` for the browser suite) is deliberately
unreachable, because every auth request in a spec file shares one counter and `beforeEach`
truncates the database, not the throttler. The 429's sentence is built from the same
`timeToBlockExpire` the guard sends as `Retry-After`, so the spec asserts the two agree rather
than pinning a string. The one-proxy case is `auth-rate-limit-proxy.e2e-spec.ts`, a file of its
own because `configureApp` installs the hop count once; it passes `TRUST_PROXY_HOPS` through
`createTestApp`'s `config`, which sets it on `ConfigService` before `configureApp` reads it.

**A stateless JWT is not revoked by a password change.** The token that made the change keeps
working, and so does every other token issued for that account, until `JWT_EXPIRES_IN_SECONDS`
elapses (default 3600). That is a property of bearer tokens, not a gap: the edit page states
it in words next to the form, which is the mitigation
[the PRD](../../docs/specs/2026-09-20-user-profile-prd.md) agreed on. Session revocation is
its own design, and an e2e test pins the current behaviour so that design has to change the
test on purpose.

### The avatar — `src/modules/user/storage` and `services/avatar-image.ts`

The user module owns bytes on disk, which until this feature only `meeting-files` did. Six
things about it are not visible in the code.

- **It does not reuse `MeetingFileStorage`, and that is the decision, not an oversight.** The
  two share a root — `MEETING_FILES_DIR`, so there is one directory to back up and one to
  point at a volume — and nothing else. `AvatarStorage` has its own key shape
  (`avatars/<uuid>.webp`), no chunk tree, and no 100 MB temp protocol, and injecting another
  module's provider here would cross a boundary the buses exist to keep. The price is a second
  small storage class; the alternative was a dependency between two modules with no reason to
  know about each other. `ContentSniffer` is not reused for the same reason, and one more: an
  avatar has to be **decodable**, not merely recognised.
- **One object per upload, not per user, and that is a correctness rule rather than a
  preference.** `AvatarStorage.newKey` generates a key nothing else names; the row is pointed at
  it, and the object it replaced is removed afterwards. With one object per account — the
  obvious `<userId>.webp` — a removal and a replacement running together cannot be told apart:
  the removal unlinks the only key there is, which may be the bytes the replacement has just
  written, leaving the row pointing at a file that is not there and every read of it a 500.
  Each request now reads the key it is replacing **inside the transaction that replaces it**,
  so it only ever unlinks the object it saw, and the two orders both end consistent. Keys of
  the older shape still resolve, so rows written before this keep working.
- **The path a client fetches is the same string for every picture an account will ever
  have**, whatever the key underneath is, so nothing about the URL says the image changed —
  which is why the row carries `avatarVersion` and why the fetch route is `no-store`. A client
  keys its fetch on the number, so a replaced avatar appears without a reload.
- **Decoding is the type check, and the header is read before anything is decoded.**
  `AvatarImage.normalise` reads the header with `sharp`, refuses anything but PNG/JPEG/WebP,
  and re-encodes to a square WebP with `fit: 'cover'`. A PDF renamed `.png` fails the same step
  that would have resized it, so there is no second sniff to disagree with. The four refusals
  carry four different sentences on purpose — empty, wrong type, too many pixels, undecodable
  are four different things to the person holding the file.
- **`MAX_AVATAR_PIXELS` is a second bound because the byte cap is not one.** A flat-colour PNG
  of 20000 squared is sixty-nine bytes and four hundred megapixels: well inside 5 MB, and a
  gigabyte of memory to decode on the request thread. The dimensions in the header are checked
  against the cap before any pixel is read, so what is decoded is never larger than it. `sharp`'s
  own `limitInputPixels` is deliberately **off** — it throws a message nothing can act on, where
  this refusal says which rule the file broke.
- **Nothing touches the stored object until the new rendition exists in full.** The rendition
  is written to a temp path and only then moved into place, so every rejection leaves the
  previous avatar being served. The e2e spec asserts that by re-fetching the bytes, not by
  checking a status.
- **The decode and the write of the rendition are separate calls, and that is the reason it is
  `toBuffer` plus `fs` rather than `toFile`.** `sharp` reports a full disk and a truncated JPEG
  identically — a message, no errno code — so one call would have to guess which it was, and a
  guess reading "that image could not be read" tells every user their picture is damaged while
  the volume is full and nothing reaches the log. Decoding yields a buffer of a few kilobytes,
  writing it is `fs`, and an `fs` failure is left to propagate as the 500 it is.
- **Synchronous inside the request, with no worker and no `processing` state.** The PRD's call:
  the user is waiting to see the picture and the file is small, so making them wait beats
  making them poll. The byte cap and the pixel cap between them are what bound the decode on
  the request thread.

The write order differs between the two commands, and each is deliberate. **Upload writes the
bytes and then the row**: the reverse would announce a version over bytes that are not there
yet. **Delete clears the row and then the bytes**: the previous URL has to stop working, and it
stops the moment the reference is gone. Both end by unlinking the object the row stopped
pointing at, and a failed unlink is an unreferenced object — logged, not a 500. Upload also
unlinks what it stored when the row never takes it, which is the only way to produce one on
that path.

Avatars need **no environment variable of their own**: the caps, the accepted types, the square
size, and the five messages are all in `@repo/shared`, because the browser checks what it can
before uploading and must say what the server would. The pixel cap is the one rule it cannot
check — counting an image's pixels means decoding it — so that refusal only ever comes back
from the API.

### The second boundary — meetings and meeting-files

`FindVisibleMeetingQuery(userId, meetingId) → { id, hostId } | null` is the read every file
route dispatches before touching a file, so a stranger, a guessed id, and a missing meeting all
get the same 404 from the same place. It selects those two columns and nothing else — whether
the meeting exists for this user, and who may manage anyone's file in it — because it runs on
every file route and twice per chunk, and a participants join there buys nothing. Widen it
only for a field a file route actually decides with. `MeetingFilesModule` does not import
`MeetingsModule`, and `MeetingsController.findOne` still reads from `MeetingsService` — two
reads sharing one `visibleTo` is the accepted price of the in-module read staying off the bus.

## Meeting files (`src/modules/meeting-files`)

What the code cannot say for itself. The PRD is `docs/specs/2026-09-19-meeting-file-upload-prd.md`
and the settled design decisions are in `docs/plans/2026-09-19-meeting-file-upload-phase-1.md`
and `-phase-2.md`; read those for _what_ was decided, this for what a reader of the code would
get wrong.

**Upload and storage**

- **Bytes first, then one transaction.** Multer writes to `<MEETING_FILES_DIR>/tmp` (never a
  100 MB buffer); the handler sniffs, `fsync`s, and `rename`s into `<meetingId>/<fileId>` (same
  filesystem, so atomic), and only then inserts — inside a transaction that first takes
  `SELECT … FOR UPDATE` on the meeting row and counts. That lock is what makes the 50-file cap
  safe under concurrency; a read-then-write would let two requests both pass. A failed insert
  removes the object, and the temp file is removed on every exit that did not rename it.
- **The interceptor resolves the meeting before it reads the body.** Nest runs interceptors
  before pipes and the handler, so without that check `MeetingFileUploadInterceptor` would
  write up to 100 MB for a non-UUID id or an invisible meeting and then reject it. The handler
  checks visibility again — a command has to be safe whatever dispatched it — and that second
  indexed read is the cost of not writing 100 MB. The check is
  `requireVisibleMeetingBeforeBody`, which the chunk route's interceptor shares.
- **The type is sniffed from the bytes, never the client's header.** `file-type` is pinned to
  **16.5.4** because 17+ is ESM-only: Node 24 would `require()` it, but Jest's loader cannot —
  both suites fail with `Cannot use import statement outside a module` — so moving past it
  means changing how Jest runs, not bumping a version; do not "upgrade" it. Its one advisory
  since (GHSA-5v7r-6r5c-r473, an ASF-parser loop that a 64-byte upload starts) is closed in the
  tokenizer the sniffer hands it: a skip of negative length throws, and the file is a 415.
  Refusing the ASF header at byte 0 was not enough — detection starts over after every ID3
  tag, so the header can sit at any offset. That tokenizer is why `strtok3` is a direct
  dependency, pinned to the 6.x line `file-type` 16 uses. Text
  has no magic bytes, so an undetected file that decodes as UTF-8 with no NUL is typed by
  extension — among `.txt`/`.md`/`.csv` only. An extension never elevates a file to a binary
  type, so `page.html` renamed `page.pdf` is a 415 while renamed `notes.txt` it is stored as
  `text/plain` and served as an attachment with `nosniff`.
- **Multer needs two options that look optional.** `defParamCharset: 'utf8'` — busboy decodes
  filenames as latin1 and `отчёт.pdf` arrives as mojibake without it — and `preservePath: true`,
  because otherwise multer takes the basename and a path separator never reaches the name rule
  that exists to reject it.
- **Both upload interceptors map multer's rejections by `code`, not by message**
  (`mapMulterError`, `src/common/multer-error.ts`). Nest 11 classifies them by comparing
  messages, multer's messages change between releases, and one Nest 11 does not recognise
  reaches the client as a 500. An upload spec attaches **with a filename**, too: multer skips a
  file part that has none before its field name is checked, so the request reaches the handler
  with no file and a field-name test passes on the handler's own 400, for the wrong reason.
- **multer is overridden to 2.4.0, above the 2.2.0 every Nest 11 `platform-express` pins**
  (`pnpm-workspace.yaml`), for its DoS fixes — and that is what makes the mapping above
  load-bearing, since 2.4.0 renamed a message Nest 11 matches on. The override goes with the
  Nest 12 upgrade; the mapping can stay.
- **Downloads declare the object's real length.** `Content-Length` is the `stat` size, not the
  record's; they differ only for a truncated object, which is already `failed` with a reason,
  and the record's length would turn that download into an aborted transfer instead of the
  bytes that exist. The `stat` is also the existence check.
- **Backups of `MEETING_FILES_DIR` are operational.** The database has the records, the
  directory has the bytes, and nothing here copies either anywhere.

**The worker's claim protocol**

- **`claimNext` is the one raw SQL statement in the module, and it has to be.** A single
  `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)` sets `status = processing`,
  `leased_until = now() + lease`, `attempts + 1`. Two replicas cannot claim one row, and a
  worker that dies leaves a row whose lease expires. Prisma cannot express `SKIP LOCKED`.
- **Every other status change goes through `MeetingFileRepository.transition`**
  (`id, from, to, patch, lease?`) — a conditional `updateMany` on the expected `from`, and
  for the worker also on the `leased_until` its claim was given, because a reclaim keeps the
  status at `processing` and status alone cannot tell the current holder from the one it
  replaced. A caller that gets `false` has lost a race and discards its result rather than
  overwriting — including removing the thumbnail it wrote, which nothing else would find.
- **A slow step keeps its lease with a heartbeat.** Transcribing an hour of audio outlasts the
  60 second lease, so the worker renews `leased_until` every `lease / 3` seconds through
  `renewLease`, **the module's second raw statement**, which returns the lease the row now
  holds. That return value is why it is raw: the final `transition` is conditional on the value
  the _last renewal_ set, not the one the claim did. A renewal updating zero rows means the row
  is no longer ours — the heartbeat reports `null`, both conditional updates miss on purpose,
  and the patch and its bytes are discarded. Renewals never overlap and `stop()` waits for the
  one in flight, since each is conditional on the lease the previous one set.
- **`attempts` counts claims, not failures.** A row claimed a fourth time is failed unrun; a
  purge claimed a fourth time is marked purged unrun with its keys logged at error level, so an
  object the process cannot unlink is not reclaimed every lease for ever. **The delete resets
  it to 0** for that reason: the purge's count starts from the processing claims otherwise, and
  a file that failed after repeated attempts (4) would be marked purged with its bytes on disk.
- **The worker claims two kinds of row, files first.** An expired or aborted session is looked
  for only when no file is claimable, because a file someone is waiting on outranks a chunk tree
  nobody will read again. `claimExpired` is the sessions' `claimNext`, under the same lease.
- **Shutdown aborts a step, and an aborted step is released, not failed.**
  `onApplicationShutdown` aborts the `signal` every step gets before waiting for the tick —
  otherwise a deploy would wait on a third party for up to `TRANSCRIPTION_TIMEOUT_SECONDS` and
  end in a SIGKILL and a lapsed lease anyway. A throw after that abort is not the file's fault:
  the worker takes `processing → uploaded`, removes what earlier steps wrote, and leaves the row
  for the next claim. A step that waits on anything outside the process must honour the signal.
- **The worker is in-process, behind `MEETING_FILES_WORKER_ENABLED` (default on).** A second
  entry point would be a second thing to start everywhere for two steps that take milliseconds.
  Every replica polls when it is on. **`test/setup-env.ts` turns it off** and the API e2e suite
  drives it through `drain()` instead, which is what makes "the row is now ready" an assertion
  rather than a race; `drain()` is reached under the string token `MEETING_FILE_WORKER`, so a
  spec compiles and fails before the worker exists.
- **Failures store copy, never causes.** Only a `StepError`'s `userMessage` reaches
  `failureReason`; anything else stores `Processing failed. You can still download the file.`
  and logs the real error with its stack. Every transition logs file id, meeting id, from, to,
  and duration.

**Delete, retry, and the purge marker**

- **`purgedAt` is the purge marker the PRD's schema lacked.** Delete is soft; the worker claims
  `deleted` rows not yet purged, removes the object, thumbnail and transcript, and sets
  `purged_at`. Without the column, "deleted rows still holding bytes" would be unknowable and a
  crash mid-`unlink` unrecoverable. The thumbnail is removed by the key `thumbnailKeyOf`
  derives, not the one on the row: a file deleted while processing is purged before the row has
  learned its key, and the thumbnail written afterwards would be orphaned.
- **Retry is the one caller of `failed → uploaded`.** `POST :fileId/retry` is a state
  transition, not a re-upload: a conditional `transition(id, 'failed', 'uploaded', …)` that
  resets `attempts` to 0 and clears `failureReason` and `processedAt`, after which the worker
  claims the row like any other. Zero rows changed means the file is no longer `failed` — that
  is the 409. Who may retry is the uploader or the host, the delete rule, with the same 404 for
  everyone else. `attempts` going back to 0 is deliberate: a retry is a fresh chance, not a
  fourth attempt against the cap of three.

**Chunked upload (phase 2)**

- **A chunked upload is a row in its own table, `meeting_file_uploads`, not a `MeetingFile`.**
  That is the PRD's "nothing is listed until the bytes are complete", enforced structurally:
  while chunks arrive there is no file row to list, download, or count against the 50-file cap,
  so no route needs a rule excluding one. Chunks live at `uploads/<uploadId>/<index>`. The row
  carries `attempts` and `leased_until` for the same reason `meeting_files` does, and
  `expires_at` is the whole lifecycle — aborting sets it to `now()`, so abort and expiry are one
  path in the worker and the row needs no status column.
- **What bounds the disk is the per-uploader cap, not the file cap.** Since a session counts
  against nothing per meeting, and an uploader need never call `complete`, the file cap alone
  let one account open 1 GiB sessions without limit and fill the volume for a day.
  `createWithinCap` refuses a sixth unpurged session per user (`MAX_OPEN_UPLOADS_PER_UPLOADER`),
  across every meeting. **Unpurged, not live**: an aborted or expired session still holds its
  chunks until the worker removes them, so counting only live ones would let abort-and-reopen
  outrun the worker. The meeting-row lock cannot serialise two meetings, so the user row is
  locked too — meeting first, then user, and `FOR NO KEY UPDATE` so rows referencing the user
  are not held up. An e2e spec opens eight at once and expects exactly five.
- **Completing a session claims it first, and expires it the moment the file exists.**
  `claimForCompletion` takes the row's `leased_until` in one conditional statement before a
  chunk is read, so of two completions racing — a client whose connection dropped and retried,
  as it is told it may — exactly one assembles and the other is a 409. The lease is the
  completion's own five minutes, not the worker's, because it has to outlast a gigabyte copy on
  a slow disk. A failure before the file exists releases it; once `UploadMeetingFileCommand` has
  answered, `expires_at` is set to `now()` **before** the chunk tree is removed, so a retry from
  then on is a 404 and never a second file. Assembly writes to `tmp/assemble-<uuid>`, never
  `tmp/<uploadId>` — two completions must not write into or remove one another's file.
- **A chunk's length is derived from the session, never believed from the request.** Every chunk
  but the last must be exactly `chunk_size`, the last is the remainder. That is what makes a
  truncated chunk a 400 instead of a hole only the checksum would catch, and why the client
  never chooses the chunk size.
- **The chunk body is parsed by `MeetingFileChunkInterceptor`, and must never move back into
  middleware.** Middleware runs before guards, so a parser there buffers up to a whole chunk of
  every `PUT` before `JwtAuthGuard` can answer — when it was middleware, an anonymous caller with
  a made-up path held 8 MiB of memory per connection. The interceptor answers the 401, 400, and
  404 first (`requireVisibleMeetingBeforeBody`, shared with the single-request interceptor so the
  two cannot drift), then parses with a one-chunk limit and inflation off; a body over the limit
  is the contract's `Chunk length does not match`, since it is the wrong length for every index.
  `express` is a direct dependency for `raw`: pnpm's strict layout means an undeclared import
  compiles and fails at boot. The specs pinning this order use `putHeadersOnly`, which declares
  a body and never sends it — supertest always sends one, and a server that rightly answers
  early fails that upload with `EPIPE`.
- **Two things about the chunked routes are not visible in the controller.**
  `MeetingFileUploadsController` is listed **before** `MeetingFilesController`, so
  `files/uploads/…` is never matched as a file id by the routes one segment shorter. And a
  session is private to whoever opened it — the host may delete anyone's file but has no
  business resuming anyone's upload — so `requireOwnedUpload` matches on `uploaderId` and
  answers the same 404 for expired, purged, another meeting's, and another user's.

**Events and the SSE stream**

- **One publisher per write, and never before it commits.** Every status change is announced on
  the in-process `EventBus` as `MeetingFileChangedEvent(meetingId, file)`: by the worker on the
  `true` branch of each conditional transition and after `markPurged`, and by the upload, delete,
  and retry handlers after theirs. A transition that lost its race changed nothing, so it
  announces nothing. The chunked path needs no publisher because `CompleteUploadHandler` ends in
  `UploadMeetingFileCommand`. The event carries the whole `MeetingFile`, not a diff: the contract
  has no version field, so a subscriber replaces the row by id and a missed event is repaired by
  the next full list.
- **Fan-out is in-process, and that fixes a single API instance.** `MeetingFileEventsService`
  subscribes once per process and keeps a `Subject` per watched meeting; `GET :id/files/events`
  is a `@Sse` route merging that with a heartbeat, ended by `MEETING_FILES_STREAM_TTL_SECONDS`.
  A second replica would have its own bus, so a change on A would never reach a stream held on B
  — **the change to make if a second replica appears is PostgreSQL `LISTEN/NOTIFY` in place of
  that one subscription**, and nothing above it moves. The heartbeat is `event: ping` with no
  data rather than a `: ping` comment because Nest's SSE writer only produces field lines from a
  `MessageEvent`; it is the same no-op for `EventSource` and the same bytes for a proxy.
- **Two things about the stream route are about Nest's own timing.** Visibility is a **guard**
  there (`VisibleMeetingGuard`) and an awaited call inside the handler everywhere else: Nest
  commits an SSE response's headers one macrotask after it subscribes, so a query awaited in the
  handler loses the race — the 200 and `content-type: text/event-stream` are already sent and
  the `NotFoundException` becomes an `event: error` on an open stream. (A malformed id is left
  to `ParseUUIDPipe`, whose throw is synchronous and does not race.) And the service ends its
  streams in **`beforeApplicationShutdown`**, not `onApplicationShutdown`: Nest closes the HTTP
  server between those hooks and `server.close()` waits for connections in flight, so a stream
  ended in the later hook is ended after the close it is blocking — SIGTERM would hang.

**Transcription**

- **It is one more `PIPELINE` entry, and that was the point of the list.** Adding
  `TranscribeStep` changed no status, no route, and nothing in the worker except the heartbeat
  and the shutdown abort. It is behind `MEETING_FILES_TRANSCRIPTION_ENABLED`, **off by default**,
  and turning it on is a restart like any other environment change. A file the step does not
  apply to — a PDF, or anything uploaded while the flag was off — is **skipped, not failed**: it
  reaches `ready` with no transcript and no reason, and turning the flag on later does not
  reprocess it. Retry does, one file at a time. `TRANSCRIPTION_API_URL` is validated at boot when
  the flag is on, so a process cannot start where every recording would fail.
- **The provider is a port with one adapter.** `TranscriptionProvider` is
  `transcribe(stream, contentType, signal)` and nothing else, bound under the string token
  `TRANSCRIPTION_PROVIDER` so a spec can substitute a fake without importing the module. The
  adapter posts an OpenAI-compatible `audio/transcriptions` request — served by hosted providers
  and self-hosted Whisper alike, which is what makes the vendor configuration rather than code.
  The object is **streamed** into the multipart body, never buffered, so a gigabyte of video
  costs a chunk of memory; that is why it is `fetch` with `duplex: 'half'` and not a `FormData`
  of `Blob`s. The endpoint's filename is derived from the sniffed type (`recording.mp3`), never
  the user's: the endpoint routes on that extension, and the user's text has no business on a
  third party's wire. Every failure is one `StepError` with one message; the vendor's own words
  stay in the log.
- **Both the flag and the TTL are read per run, not in a constructor**, so the e2e suite can
  change them with `ConfigService.set` between tests.

## Bootstrap behaviour (`src/configure-app.ts`)

**Every global belongs in `configureApp`, not in `main.ts`.** `main.ts` and the e2e test app
both call it, so a global added in one place cannot go missing from the other — the e2e specs
assert behaviour that only exists because of these, and would keep passing against a test app
that had quietly diverged. Only process-level concerns (`enableShutdownHooks`, `listen`) stay
in `main.ts`.

- **Global prefix `api`** — a controller at `@Controller('health')` serves `/api/health`.
- **Express's `trust proxy`, from `TRUST_PROXY_HOPS`** (default 0) — what `req.ip` is, and so
  whose budget the auth throttle charges. Here and not in `main.ts` so the e2e app has it too.
- **`ValidationPipe`** with `whitelist`, `forbidNonWhitelisted`, and `transform`. Bodies and
  queries should be class-validator DTO classes; unknown properties are rejected rather than
  silently dropped.
- **Implicit conversion is deliberately off.** With it on, class-transformer coerces a value
  into whatever the DTO property is typed as, so `{"password": 12345678}` arrives as
  `"12345678"` and passes `@IsString()` — the API would accept credentials of any JSON type.
  The cost is that a numeric query or param DTO needs an explicit `@Type(() => Number)`.
- **`HttpExceptionFilter`** and **`LoggingInterceptor`** from `src/common/`.
- **Security headers from `helmet`, first in the chain** so a CORS preflight carries them too.
  The policy is `default-src 'none'` with no framing, because nothing here should ever render;
  a response that did would load, run and embed nothing. **HSTS is off on purpose** — it
  belongs to whatever terminates TLS, which this process cannot see. `security-headers.e2e-spec.ts`
  pins the set, on a refusal as well as an open route.
- **CORS names only `CORS_ORIGINS`** — see [Environment](#environment) for the development
  default and who sets it explicitly. A foreign origin still gets
  `Access-Control-Allow-Credentials` from the `cors` package; what it never gets is
  `Access-Control-Allow-Origin`, the header a browser actually checks.
- **Shutdown hooks** are enabled in `main.ts`, which is what lets `PrismaService` disconnect
  cleanly. Deliberately not in `configureApp`: the test harness must not install them.

## Environment

Every variable the app cannot start without belongs in the `EnvironmentVariables` class in
`src/config/env.validation.ts`; validation runs at boot, so misconfiguration fails immediately
instead of at the first request that needs it. Adding one means the class, `.env.example`, and
— if it affects local Docker — `docker-compose.yml`.

**A rule the contract cannot express with a type is still the contract's job.** `JWT_SECRET`
is rejected when it is one of the placeholders this repository has published, not only when it
is too short: the old compose default was 44 characters, so the length rule passed it and a
deployment that never set the variable booted and signed real tokens with a key that is in
git. Any value that ships in an example belongs in `PUBLISHED_JWT_SECRETS`, and no example
should carry a usable one — both `.env.example` files leave it empty.

**`CORS_ORIGINS` is required in production and defaulted everywhere else**, and the default is
the part that bites. Unset or blank outside production it is the web app `pnpm dev` runs —
`localhost` and `127.0.0.1` on `WEB_PORT`, which `scripts/dev.mjs` hands both apps, so it
follows the web app when 3000 is taken. Anything else is set explicitly: a phone reaching the
dev server over the network, the compose stack (`docker-compose.yml` sets the local web
service), and both test runs — `setup-env.ts` and `start:e2e-web` allow the browser suite's
3100 and nothing else. Entries are exact origins because the `cors` package compares them
exactly; the contract refuses a path or trailing slash rather than let an entry match nothing.

`ConfigModule` is global and reads `.env.local` then `.env`. Neither overrides a variable
already in `process.env`, which is what lets the root `pnpm dev` decide `PORT` — and why an
`EADDRINUSE` retry in `main.ts` is the wrong fix; see
[the root guide](../../AGENTS.md#pnpm-dev-picks-the-ports-before-turborepo-starts).

## Prisma 7 specifics

- The `datasource` block has **no `url`**. The CLI reads the connection string from
  `prisma.config.ts`; the runtime client receives it through the `PrismaPg` driver adapter
  constructed in `PrismaService`.
- The client is generated into `src/generated/prisma` and imported from there — not from
  `@prisma/client`. That directory is gitignored, so `prisma generate` must run before a build
  or typecheck on a clean clone (the `build` script does this).
- `prisma.config.ts` falls back to the docker-compose connection string so `generate` works
  without a `.env`. Commands that reach the database still need a real `DATABASE_URL`.
- **`prisma generate` is not implied by editing the schema.** A model added without it produces
  `Property 'user' does not exist on type 'PrismaService'`, which reads like a broken import
  rather than a stale client — as does a _whole spec suite_ failing to compile after a pull that
  added one.
- **Columns are snake_case, models are camelCase.** Every multi-word field carries a `@map` and
  every model a `@@map` — `User.passwordHash` is `users.password_hash`. The e2e helpers read
  those column names over raw SQL, so a mapping change breaks them loudly.

Database work goes through `PrismaService` (injectable, owns connect/disconnect via
`OnModuleInit`/`OnModuleDestroy`), exported by `PrismaModule`.

## Lint overrides that matter here

`.oxlintrc.json` relaxes two rules for `apps/api/**`: `typescript/consistent-type-imports` is
off (Nest resolves constructor dependencies from emitted decorator metadata, which a type-only
import erases), and `typescript/no-extraneous-class` allows decorated empty classes (Nest
modules). Import injectable classes as values, not types.

## Tests

Jest, configured inline in `package.json` with `rootDir: src` and `testRegex: .*\.spec\.ts$` —
unit specs sit beside the code. E2E specs use `test/jest-e2e.json` and Supertest. Not Vitest —
that's the web app.

**Neither `pnpm test` nor CI runs `test:e2e`** (it is not in `turbo.json`, and CI has no
Postgres), **so a module whose only coverage is an e2e spec is uncovered as far as CI is
concerned.** Every command handler, query handler, and read service gets a `*.spec.ts` beside
it for that reason, not for a coverage number.

E2E specs run against the **real database** `DATABASE_URL` points at — by default your
development one; point it elsewhere if local rows matter to you. `test/utils/create-test-app.ts`
boots `AppModule` and `useApiSuite` truncates the tables it touches, so `test:e2e` needs
`docker compose up -d postgres` and a migrated schema — without them every test fails in
`beforeEach` with `relation "..." does not exist`, which reads like a broken suite and is
really a missing database. Cleanup runs at both ends for different reasons: `beforeEach` so no
test inherits another's rows (which is also what makes a repeated run independent of the last),
`afterAll` so the final test's fixtures are not stranded. **The web app's Playwright suite
truncates the same table, so the two must never run at the same time.**

Six things about that setup are easy to get wrong:

- **Environment must be set in `test/setup-env.ts`, not in a helper.** `ConfigModule.forRoot()`
  is evaluated when `app.module.ts` is _imported_ and prefers `process.env`, so anything
  assigned after that import — including at the top of `createTestApp` — is too late, and the
  app signs tokens with the developer's local `JWT_SECRET` while the specs verify with the test
  one. The failure looks like broken signing code, not configuration. Jest `setupFiles` runs
  early enough. The same file points `MEETING_FILES_DIR` at a per-run temp directory and sets
  `MEETING_FILES_WORKER_ENABLED=false`.
- **`start:e2e-web` must stay in step with it**: the same temp-dir idea, but the worker **on**
  with a fast poll, because the web app's browser suite watches the Processing chip disappear —
  and the same out-of-reach auth rate limit, because that suite registers through the UI in
  every spec and would meet a deployment's ten a minute part-way through a run.
- **`maxWorkers: 1` is load-bearing**, for the same reason: Jest parallelises across spec
  files, and in parallel they delete each other's fixtures and a seeded `register` starts
  returning 409. Remove it only alongside per-worker database isolation.
- **`test/utils/` reads the database over raw SQL**, not through `prisma.user`, so the specs pin
  table and column names directly. A response is not evidence about what was written: asserting
  through the API would reuse the same `include` the implementation does, so a row the code
  never meant to write — the host landing in `meeting_participants` — would be invisible.
  `truncateUsers` cascades to `meetings`, `meeting_files`, and `meeting_file_uploads`, which is
  why the file specs need no cleanup of their own and why there is deliberately no second
  truncation helper to disagree with it about what "clean" means. The files' helpers also seed
  states a route cannot produce on demand (`leased_until`, `attempts`, `purged_at`, a past
  `expires_at`).
- **`test/utils/sse.ts` is the only client that can read a stream route**, over Node's `http`
  directly. Supertest buffers a whole response and resolves when the server ends it, which for
  `files/events` is after the TTL — ordering could not be asserted and every test would cost the
  TTL. The helper parses events as they arrive and hands them over one at a time; a non-200 is
  read to completion and exposed as `body`.
- **`test/utils/jwt.ts` verifies tokens with `node:crypto` alone**, never the library the API
  signs with, so a token only `@nestjs/jwt` can read fails the assertion. It is checked against
  a signature produced by `openssl dgst -sha256 -hmac`. Do not "simplify" it into `JwtService`.

## Keeping this guide current

Update it in the same commit as the change;
[the root guide](../../AGENTS.md#keeping-documentation-current) covers the general rules, this
one owns what is specific to `@repo/api`. The sections above each name what would invalidate
them — a global added to `configure-app.ts`, a Prisma upgrade that moves the constraint `meta`
shape, a fourth message on the auth/user boundary, a new exemplar module replacing one of the
four, the first event or saga, a change to the `apps/api/**` lint overrides. Adding a feature
module that follows the existing shape needs no update: document the shape, not each module
that uses it.
