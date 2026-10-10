# Package guide — `@repo/api`

> **`AGENTS.md` is the guide; `CLAUDE.md` beside it imports it.** Write every change here.

The Nest.js 11 backend. Read [the root guide](../../AGENTS.md) first for workspace-wide
commands and conventions.

## Commands

The root scripts apply with `--filter=@repo/api`; `build` here is `prisma generate && nest build`.
This package's own:

```bash
pnpm --filter=@repo/api test:e2e         # jest with test/jest-e2e.json — see Tests
pnpm --filter=@repo/api test:live        # real requests to Anthropic — see Tests
pnpm --filter=@repo/api test:watch
pnpm --filter=@repo/api prisma:generate
pnpm --filter=@repo/api prisma:migrate   # prisma migrate dev
pnpm --filter=@repo/api prisma:studio
```

One thing here is started by another program and never through `pnpm`: the meeting's tasks
as an MCP server on stdio, `node dist/meeting-tools-stdio.main.js <meeting-id>` from this
directory, after a build and with its user's access token in `MEETING_TOOLS_ACCESS_TOKEN`
(_Meeting tools_, below, has why there is no script for it).

## Layout

```
src/
  main.ts               Process bootstrap: create app, configureApp, shutdown hooks, listen
  meeting-tools-stdio.main.ts
                        A second process, not part of the API's: the meeting's tasks as an
                        MCP server on stdio, started by its client as a subprocess
  configure-app.ts      Every global that shapes request handling
  app.module.ts         Root module — register new feature modules here
  config/               Environment contract
  common/               Cross-cutting: the exception filter, logging/ for the request log
                        and for a logger that keeps off stdout,
                        shutdown/ for what the process does with its connections when it
                        is stopped, and processing/ for what every polling worker shares
  modules/<feature>/    One directory per feature: module, controller, specs, and
                        commands/ — a command class plus its handler per write operation.
                        queries/ mirrors it where a read crosses a module boundary,
                        events/ where a module publishes an event or handles one.
                        services/ holds collaborators the handlers share.
                        storage/ and processing/ appear where a module owns bytes on disk
                        or a background worker (meeting-files has both, meeting-digests
                        a worker).
  generated/prisma/     Prisma client output — generated, gitignored, never edit
prisma/
  schema.prisma         Datasource, generator, and models
  migrations/           Applied migrations — never edit one that has shipped
```

Five worked examples, in the order worth reading them:

- **`auth`** — the shape to copy for a new feature module. CQRS, one command class and one
  handler per write, and that is the house style for anything new, not an exception.
- **`meetings`** — the mixed case: `POST /meetings` is a command, the two reads stay on a
  plain service.
- **`user`** — read before splitting a module in two. It owns the user record and exports
  nothing; two modules deep in a request path talk to it entirely over the buses.
- **`meeting-files`** — the largest: two commands, a read service, a storage service over
  `fs`, and two polling workers. It has its own section below because most of what it does
  right is invisible in the code.

- **`meeting-digests`** — read after `meeting-files`, whose worker it copies. It is also the
  one module that reaches three others — `meeting-files`, `meetings`, `user` — and imports
  none of them: five queries, one event in and one out, and the visibility read. It has a
  section of its own below.

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
no sagas, and two events on the in-process `EventBus` — `MeetingFileChangedEvent` and
`MeetingDigestChangedEvent` (see _Events and the SSE stream_). The files stream subscribes to
the bus by hand, for both; the digest's two `@EventsHandler`s — one for a recording that was
transcribed, one for a file that was deleted — both handle the files' event, and like a
command handler neither does anything until it is in its module's `providers`. `CqrsModule`
is imported per feature module, never
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

**Verifying a token is a module of its own, `AccessTokenModule`, inside `auth`.** It holds
the one `JwtModule` registration — the key and the pinned algorithm — and
`AccessTokenVerifier`, whose `subjectOf(token)` is the whole of how a token is verified and
answers `null` for one that is not — one with no expiry included, which the library would
accept and this API never issues: `JwtAuthGuard` turns that into a 401, and the meeting
tools' stdio server into a process that does not start. `AuthModule` imports it and exports
it with the guard, because a guard is instantiated in the module that uses it and injects the
verifier there. It is separate because that stdio process imports it **alone**: a process
that takes a token has no use for the credential routes, argon2, or the rate limit, and
`AuthModule`'s factories ask for variables it does not have. For the same reason **a token's
lifetime is set by `TokenService` as it signs, not in the `JwtModule` registration** —
there, importing the module to verify would ask for `JWT_EXPIRES_IN_SECONDS`, and outside
the API's contract that variable is text, which the signing library reads as milliseconds.

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

**The two handlers that answer across this boundary are `MeetingQueriesModule`**
(`meeting-queries.module.ts`), which `MeetingsModule` imports: `FindVisibleMeetingHandler`
and `FindMeetingMemberIdsHandler`, apart from the controller and from `AuthModule`. The API
is unchanged by the split — every handler still lands on the one set of buses. It exists for
the meeting tools' stdio process, whose root module imports it alone to ask whether its user
can see its meeting; a third handler that crosses out of `meetings` goes there too.

### The third boundary — what meeting-digests asks of the others

`meeting-files` answers three queries for whatever describes a meeting as a whole:
`FindTranscribedRecordingsQuery(meetingId)` — which recordings are transcribed, id and
uploader — `FindMeetingTranscriptsQuery(meetingId, maxCharacters)` — what was said in
them, in upload order — and `FindTranscribedRecordingsByMeetingQuery()` — the first of
those for every meeting at once, ids only. Four things about them:

- **Neither carries a user or checks visibility.** Who may ask about the meeting is the
  caller's to have decided, as it is for `FindUserByIdQuery`; a route that dispatches one
  without `FindVisibleMeetingQuery` first has published a meeting's transcripts.
- **A storage key never crosses.** The handlers answer ids and text; a path under
  `MEETING_FILES_DIR` is this module's business.
- **The every-meeting query is never dispatched for a request.** It names every meeting
  that has a recording, and no visibility check can stand in front of that. Its one caller
  is the digest's catch-up, at boot. **It reads under exactly the one-meeting query's
  conditions, from one constant** (`TRANSCRIBED_RECORDING`): the catch-up calls a digest
  current when its sources are the recordings transcribed now, and a generation's sources
  are what the one-meeting read answered — so a row only one of the two counts is a digest
  asked for again at every boot.
- **The transcripts query stops at `maxCharacters` instead of loading past it**, and answers
  `withinLimit: false` with no text at all rather than part of it. A transcript is checked by
  its size on disk before it is read — UTF-8 never spends more than three bytes on what a
  string's `length` counts as one — so memory is bounded by the limit, not by a meeting of
  fifty one-gigabyte recordings.

**For an action item's owner it asks two more, of the other two modules**:
`FindMeetingMemberIdsQuery(meetingId)`, which `meetings` answers — the host and the
participants, ids only, `null` for no such meeting — and `FindUsersByIdsQuery(userIds)`,
which `user` answers — an id and a display name each, in one statement.

- **Neither carries a user or checks visibility either.** The worker has no user to carry,
  and the read has already decided. A route that dispatched `FindUsersByIdsQuery` with ids
  its caller chose would have published every user's name.
- **`FindUsersByIdsQuery` selects two columns instead of mapping a row down.** It is the one
  read that hands a user's name to somebody else, so an email address is never loaded on
  the way; `UserDisplayName` is declared beside it for the reason `UserCredentials` is
  declared beside its queries.
- **The member ids are a query of their own, not a third column on
  `FindVisibleMeetingQuery`**, which stays the two columns every file route pays for.

**And one event comes back.** `MeetingDigestChangedEvent(meetingId, digest)` is published by
`meeting-digests` after every committed write, and the files stream forwards it to the
meeting's open pages. That class — a meeting id and a `MeetingDigest`, imported for an
`instanceof` — is everything `meeting-files` knows of the digest; neither module is in the
other's `imports`, and neither reads the other's table.

## Meeting files (`src/modules/meeting-files`)

What the code cannot say for itself. The PRD is `docs/specs/2026-09-19-meeting-file-upload-prd.md`
and the settled design decisions are in `docs/plans/2026-09-19-meeting-file-upload-phase-1.md`
and `-phase-2.md`; read those for _what_ was decided, this for what a reader of the code would
get wrong. Transcription has a PRD and a plan of its own, named under _Transcription_ below.

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
  `requireVisibleMeetingBeforeBody`; the chunk route's interceptor makes the same two reads
  through the same two helpers, and then goes on to the session.
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
  `text/plain` and served as an attachment with `nosniff`. **An MP4 is named by its major
  brand**, so one allow-listed type arrives under several names — `M4V ` as `video/x-m4v`,
  `M4A ` as `audio/x-m4a` — and each needs an entry in the sniffer's `ALIASES`, or the picker
  offers an extension the API answers with a 415. Check a container with a file an encoder
  wrote: an `isom` MP4 renamed `.m4v` is `video/mp4` already and proves nothing.
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

- **A claim is one raw SQL statement, and it has to be.** `MeetingFileRepository.claimNext` is
  a single `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)` that sets
  `status = processing`, `leased_until = now() + lease`, `attempts + 1`. Two replicas cannot
  claim one row, and a worker that dies leaves a row whose lease expires. Prisma cannot express
  `SKIP LOCKED`. **Its `RETURNING` lists every column of `MeetingFileRecord`**: the worker's
  events are built from that row, and a column left out is `undefined` where `toMeetingFile`
  tests for `null`. A column added to `meeting_files` goes into this list and the transcription
  claim's in the same commit.
- **Every other status change goes through `MeetingFileRepository.transition`**
  (`id, from, to, patch, lease?`) — a conditional `updateMany` on the expected `from`, and
  for the worker also on the `leased_until` its claim was given, because a reclaim keeps the
  status at `processing` and status alone cannot tell the current holder from the one it
  replaced. A caller that gets `false` has lost a race and discards its result rather than
  overwriting — including removing the thumbnail it wrote, which nothing else would find.
- **A slow claim keeps its lease with a heartbeat.** `startLeaseHeartbeat` — in
  `src/common/processing`, beside `PollingLoop`, because the digest worker in another module
  uses both — renews the lease every `lease / 3` seconds through the repository's `renewLease` — raw as well, because it
  returns the lease the row now holds, and the final conditional write is on the value the
  _last renewal_ set, not the one the claim did. A renewal updating zero rows means the row is
  no longer ours — the heartbeat reports `null`, the conditional writes miss on purpose, and the
  result and its bytes are discarded. Renewals never overlap and `stop()` waits for the one in
  flight, since each is conditional on the lease the previous one set. Both workers here use it. No
  file step outlasts the 60 second lease today; a transcription always does, and passes an
  `onLost` so its request is hung up the moment the claim is gone rather than minutes later.
- **`attempts` counts claims, not failures.** A row claimed a fourth time is failed unrun; a
  purge claimed a fourth time is marked purged unrun with its keys logged at error level, so an
  object the process cannot unlink is not reclaimed every lease for ever. **The delete resets
  it to 0** for that reason: the purge's count starts from the processing claims otherwise, and
  a file that failed after repeated attempts (4) would be marked purged with its bytes on disk.
- **The worker claims two kinds of row, files first.** An expired or aborted session is looked
  for only when no file is claimable, because a file someone is waiting on outranks a chunk tree
  nobody will read again. `claimExpired` is the sessions' `claimNext`, under the same lease.
- **Shutdown aborts a step, and an aborted step is released, not failed.**
  `onApplicationShutdown` aborts the `signal` every step gets before waiting for the tick, so a
  step that waits on something outside the process cannot hold a deploy for as long as its own
  timeout allows. A throw after that abort is not the file's fault: the worker takes
  `processing → uploaded`, removes what earlier steps wrote, and leaves the row for the next
  claim, its claim count as it was. No step waits on anything outside the process today; one
  that does must honour the signal.
- **Transcription has a claim of its own, on the same row.** `MeetingFileTranscriptionRepository`
  and `MeetingFileTranscriptionWorker` mirror the pair above on `transcription_leased_until` and
  `transcription_attempts`. The file's lease and count cannot be shared: the purge claims on
  them and a delete resets them. Four things differ from the file claim, each on purpose:
  - **A polling loop of its own.** `MeetingFileWorker` handles one claim per tick, so a
    ten-minute transcription inside it would hold every other upload at `uploaded`. One loop per
    process also bounds a replica to one transcription at a time. It polls only where the file
    worker does and only while transcription is switched on, and the e2e suite drains it under a
    token of its own, `MEETING_FILE_TRANSCRIPTION_WORKER` — which is how a spec sees a file
    that is `ready` while its transcription is still queued.
  - **Every write requires `status = 'ready'`**, as well as the expected transcription status
    and the lease. That one condition is all of "deleted while transcribing": the delete handler
    knows nothing about transcription, the row simply stops being `ready`, the next renewal
    finds nothing and hangs up, and a transcript that was already written is removed by the
    write that then misses. **That write removes it only when the file has gone.** A write
    that misses with the file still `ready` lost its claim to another worker instead, and the
    transcript's key is one per recording, not one per claim: by then it may hold what that
    worker recorded, so it is left alone. **One key is safe because of two things, and both
    have to stay true.** Two claims of a recording send the same bytes to the same model, so
    either text is that recording's transcript; and `writeText` renames a finished file into
    place, so a late claim replaces a committed transcript whole or not at all. A key per
    claim would cost the purge its way of finding a transcript: it removes by the key it
    derives, and a worker that died between writing its text and recording it would leave a
    file no row names.
  - **A graceful shutdown hands the claim back uncounted.** `release` is `TRANSCRIBING → QUEUED`
    with `transcription_attempts - 1`, and `transition` refuses that edge so nothing takes it
    without the decrement. A deploy is expected to land on work that runs for minutes, so no
    number of deploys may fail a recording. A crash decrements nothing: the lease lapses, the
    next claim counts, and a fourth claim is failed unrun — which bounds a recording that kills
    the process that transcribes it.
  - **It lets go in `onModuleDestroy`, not `onApplicationShutdown`.** Handing a claim back is a
    write, and `PrismaService` disconnects in its own `onModuleDestroy`, which Nest runs last for
    a global module — so the connection is still open. The worker also waits for a claim that
    `drain()` started, not only the loop's, and takes none once shutdown has begun, or it would
    claim straight back the row it has just released.
- **The worker is in-process, behind `MEETING_FILES_WORKER_ENABLED` (default on).** A second
  entry point would be a second thing to start everywhere for steps that take milliseconds.
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
- **The transcription retry is the one caller of `failed → queued`, and it is not the retry
  above.** `POST :fileId/transcription/retry` never touches the file, which is `ready` before
  and after: it is one conditional
  `MeetingFileTranscriptionRepository.transition(id, FAILED, QUEUED, …, null)` that resets
  `transcription_attempts` to 0 and clears the reason, after which the transcription worker
  claims the row like any other queued one. Zero rows changed is the 409, whatever the row was
  instead — queued, running, transcribed, a file with no transcription at all. The gate, its
  order, and its 404s are the file retry's. **The handler does not ask whether transcription is
  switched on:** with the setting off the row is queued all the same and waits for it to come
  back, as every queued row does — the route's contract has no other answer to give.
  **One failure it refuses, with its own 409: the time limit** (product's call, 2026-10-08,
  narrowing the PRD's "Retry where allowed"). The same recording under the same limit ends the
  same way, and hanging up does not stop Whisper, so each retry would start a second
  transcription beside the one still running. The row stores copy, not a cause, so the
  handler recognises it by `isMeetingFileTranscriptionTimeLimitReason` in `@repo/shared` —
  the file that also builds that sentence, and the only one that may spell how it opens.

**Chunked upload (phase 2)**

- **A chunked upload is a row in its own table, `meeting_file_uploads`, not a `MeetingFile`.**
  That is the PRD's "nothing is listed until the bytes are complete", enforced structurally:
  while chunks arrive there is no file row to list, download, or count against the 50-file cap,
  so no route needs a rule excluding one. Chunks live at `uploads/<uploadId>/<index>`. The row
  carries `attempts` and `leased_until` for the same reason `meeting_files` does, and
  `expires_at` is the whole lifecycle — aborting sets it to `now()`, so abort and expiry are one
  path in the worker and the row needs no status column.
- **That "now" is the earlier of two clocks, and has to be.** `findOwned` compares the expiry
  with this process's clock and every claim with PostgreSQL's `now()`, and the two are never
  quite one — the database's is a VM's. Stamped with either alone, a session ended on purpose
  stayed live to the other for as long as they differed: not yet the worker's to collect, and
  still open to a completion. That failed `collects an aborted session` once in 500 runs.
  `expire` writes `LEAST(now(), <this clock>)`, and `meeting-file-upload-expiry.e2e-spec.ts`
  holds it to that with this process's clock moved five seconds each way.
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
- **A chunk is moved into place while its session's row is held `FOR SHARE`**
  (`MeetingFileUploadHoldRepository.whileLive`). A session is ended by a write to its row —
  an abort, a completion, the worker's claim of an expired one — after which the worker
  removes its tree and marks it purged. A chunk still on its way to the disk at that moment
  used to be renamed into a tree nobody would look at again, since `purged_at` keeps the row
  from being claimed twice: up to 8 MiB for good each time an upload was cancelled with a
  request in flight. Held, everything that ends the session waits for the write — the
  worker's claim passes over a locked row — so the purge that follows finds the chunk.
  **Only the rename runs under the hold, and no more than three holds are open at once**
  (`ConcurrencyLimit`). A hold pins a pooled connection until its write returns, and the pool
  is ten for every route: with a whole chunk flushed under it and no bound on how many ran,
  one account sending chunks side by side held all ten and every other request waited on the
  pool. So the file is flushed before the hold and its directory after it, and a fourth hold
  waits in memory instead of in the pool.
  `FOR SHARE` and not stronger, so two chunks of one session are still written side by side;
  the index is recorded after the hold, by the statement that always did, because recording
  it under the hold would have two chunks each waiting for the other's lock.
  `meeting-file-upload-hold.e2e-spec.ts` holds the order against a real Postgres.
  **The hold has a time limit — a minute — and running out of it ends the lock, not the
  move.** A move that outlives it finishes unheld, which is the gap the hold exists to close,
  so `StoreChunkHandler` follows up a hold that failed: it waits for the move to settle, asks
  whether the session is still live, and removes the tree of one that is not, since the
  purge may already have been. A live session keeps the chunk, unrecorded, for its own purge.
- **A chunk's length is derived from the session, never believed from the request.** Every chunk
  but the last must be exactly `chunk_size`, the last is the remainder. That is what makes a
  truncated chunk a 400 instead of a hole only the checksum would catch, and why the client
  never chooses the chunk size.
- **The chunk body is parsed by `MeetingFileChunkInterceptor`, and must never move back into
  middleware.** Middleware runs before guards, so a parser there buffers up to a whole chunk of
  every `PUT` before `JwtAuthGuard` can answer — when it was middleware, an anonymous caller with
  a made-up path held 8 MiB of memory per connection. The interceptor answers the 401, the
  400s, and both 404s first — `requireOwnedUploadBeforeBody`, built from the helpers the
  single-request interceptor's check uses (`callerOf`, `uuidParamOf`) so the two cannot drift —
  and the 400 for an index the session has no chunk at. **The session, and not only the
  meeting**: anyone can create a meeting, so "may see the meeting" is true of every account
  for one of its own, and until the session was asked about first a signed-in caller with a
  made-up session id held the same 8 MiB. Only then does it parse, with inflation off and a
  limit of the length _this_ chunk has to have; a body over that is the contract's
  `Chunk length does not match`. What is left is what a session entitles its owner to: one
  chunk of it in memory per connection, for as long as the connection may stall. Closing that
  means streaming the body to `tmp/` instead of buffering it, and a cap on chunks in flight
  per account.
  `express` is a direct dependency for `raw`: pnpm's strict layout means an undeclared import
  compiles and fails at boot. The specs pinning this order use `putHeadersOnly`, which declares
  a body and never sends it — supertest always sends one, and a server that rightly answers
  early fails that upload with `EPIPE`. The cases for a caller the meeting does not know are in
  `meeting-file-uploads.e2e-spec.ts`; a member naming a session or a chunk that is not theirs
  is `meeting-file-chunk-before-body.e2e-spec.ts`.
- **Two things about the chunked routes are not visible in the controller.**
  `MeetingFileUploadsController` is listed **before** `MeetingFilesController`, so
  `files/uploads/…` is never matched as a file id by the routes one segment shorter. And a
  session is private to whoever opened it — the host may delete anyone's file but has no
  business resuming anyone's upload — so `requireOwnedUpload` matches on `uploaderId` and
  answers the same 404 for expired, purged, another meeting's, and another user's.

**Events and the SSE stream**

- **One publisher per write, and never before it commits.** Every status change is announced on
  the in-process `EventBus` as `MeetingFileChangedEvent(meetingId, file)`: by the file worker on
  the `true` branch of each conditional transition and after `markPurged`, by the transcription
  worker after a claim and on the `true` branch of each of its writes, and by the upload, delete,
  and two retry handlers after theirs. A transition that lost its race changed nothing, so it
  announces nothing. The chunked path needs no publisher because `CompleteUploadHandler` ends in
  `UploadMeetingFileCommand`. The event carries the whole `MeetingFile`, not a diff: the contract
  has no version field, so a subscriber replaces the row by id and a missed event is repaired by
  the next full list.
- **A worker's claim is never announced before the write that handed it the row** — that is
  `MeetingFileHandOvers` (`services/meeting-file-hand-overs.ts`). The two are announced by
  different actors, each when its own write returns, and Node does not always resume them in
  the order PostgreSQL committed them. Measured on 2026-10-08 with the retry handler against
  the transcription worker, the claim issued continuously: "transcribing" was announced before
  "queued" in 8 of 3,200 runs, and since a subscriber replaces a row by id, the page kept
  "Queued for transcription" under a running transcription until its next full list. So a
  hand-over — the upload, either retry, and the file worker's `ready`, which is the write that
  queues a recording — runs its write and its announcement as one registered step, and each
  worker waits for the steps in flight for a file before it announces a claim of it. After
  that, 0 of 6,400. **A new write that makes a row claimable has to run through it too.**
  **Only claims wait, and only for hand-overs**, because a claim is the one thing that proves
  an order: the row was not claimable until its hand-over committed. Two writes that do not
  depend on each other — a delete beside a retry — are still announced as each returns, and
  making one wait for the other would misorder them as often as not. It is in-process, like
  the fan-out below, and `LISTEN/NOTIFY` issued inside the writing transaction would replace
  it, since PostgreSQL delivers notifications in commit order.
- **Nothing is sent for a file after its `deleted` has been** — `AnnouncedDeletes`, asked by
  `MeetingFileEventsService` for every event. A delete and a worker's write are the unordered
  pair above with a lasting effect: the write commits, then the delete, and Node resumes the
  delete's handler first. A subscriber takes an id it no longer holds for somebody else's
  upload and puts the row back — a file that is gone, with a transcript link that answers 404
  — until its next full list. It needs no order to close: `deleted` is terminal and every
  other write is conditional on the row not being deleted, so anything after it is an older
  state announced late, and dropping it is right either way. The purge's repeat of `deleted`
  still goes out. The last 1,024 deletes are remembered, which a late event, trailing its
  delete by milliseconds, cannot outrun.
- **The digest is a second event on this stream, and it orders itself.**
  `MeetingDigestChangedEvent` is forwarded as `event: digest` beside `event: file`: a second
  stream would double every meeting page's long-lived connections against a browser's six per
  origin, and who may watch a meeting's digest is who may watch its files. Its data is the
  whole `MeetingDigest` as `GET :id/digest` answers it — read again after the write, by the
  code that route runs, because what a digest shows depends on which recordings are
  transcribed now and no write to its row knows that. **It carries `version`, which is why it
  goes through neither mechanism above.** A subscriber keeps the higher of two, and that one
  comparison settles everything the files contract needs machinery for: two writes announced
  out of order, an event that arrives after the fetch that already saw it, and a snapshot
  taken one write later than the write that caused it. `MeetingFileHandOvers` and
  `AnnouncedDeletes` exist because a `MeetingFile` has nothing to compare; do not put the
  digest through either, and do not send a digest without its version having risen for
  whatever changed. A client that does not know the name ignores it, as a heartbeat is.
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
- **A stream opened after shutdown began ends at once, and it does get opened.** The page
  reopens its stream a second after it ends, and a kept-alive socket still carries that request
  to the process that is closing. The shutdown signal is therefore a `ReplaySubject`: with a
  plain `Subject` the late stream missed the one emission and ran to the TTL — five minutes of
  a closing process kept alive, and of a page shown nothing while the process that replaced it
  did the work, because the bus subscription had already gone. The socket itself is closed
  behind that answer by `ConnectionDrainService` (see _Bootstrap behaviour_); this half is
  what ends the response it is waiting for.

**Transcription**

- **A recording is `ready` first, and its transcription is a status of its own.**
  `MeetingFile.transcriptionStatus` — `queued`, `transcribing`, `transcribed`, `failed`, or
  absent — moves beside `status`, which never waits for a transcript and is never changed by
  one. The contract is [the PRD](../../docs/prd-local-whisper-transcription-status.md) and the
  decisions under it are in [its plan](../../docs/plan-local-whisper-transcription-status.md).
  The stored enum is UPPER_CASE, as `.claude/rules/prisma.md` asks, and the wire's is
  lower-case; `meeting-file.mapper.ts` is the one place that translates, through a `Record`
  that does not compile with a status missing. `transcriptPath` is still "a transcript
  exists": `transcript_key` is set by the write that makes a row `transcribed` and by no other.
  Recordings the old pipeline step transcribed had the key and no status; a migration gave
  them `TRANSCRIBED`, so the page offers their transcripts too.
- **Queueing is the pipeline's last step, and that is all the pipeline has to do with it.**
  `QueueTranscriptionStep` returns `transcriptionStatus: QUEUED` for an audio or video file
  while `MEETING_FILES_TRANSCRIPTION_ENABLED` is on, and the file worker merges a step's patch
  into its `processing → ready` write — so "ready" and "queued" are one statement and one
  event. Everything else follows from the position: a file that fails a step never gets a
  status, a retried file gets one when it reaches `ready`, a PDF never does, and **a file that
  became `ready` while the setting was off is never queued**, because nothing revisits a
  `ready` row. Keep it last: the patch of a step that ran before one that threw is written with
  the failure, so a step after it would put `queued` on a failed file.
- **Switching the setting off stops new work and nothing else.** No file is queued and the
  transcription worker claims nothing; a `transcribed` row keeps its transcript, a `failed` row
  its reason, and a `queued` row waits for the setting to come back. Turning it on is a restart
  like any other environment change — but the step and the worker ask `ConfigService` when they
  run, not in a constructor, so the e2e suite can flip it with `ConfigService.set` between
  tests, as it does the stream's TTL. `TRANSCRIPTION_API_URL` is validated at boot when the
  setting is on — **its shape, never the server**. A Whisper that is not running fails a
  transcription; it must not stop the process that serves every upload and download.
- **A failed transcription stores fixed copy the worker chose, and nothing retries it unasked.**
  Three sentences from `@repo/shared`: a generic one, one that names
  `TRANSCRIPTION_TIMEOUT_SECONDS` when that limit is what aborted the request, and one for a
  fourth claim. Which applies is decided from what ended the request — the worker owns the time
  limit, the shutdown, and the lost-claim signals — and never from what the provider threw, so
  nothing Whisper says can reach `transcriptionFailureReason`. **The limit and the shutdown
  are read as the provider settles, not once the heartbeat has stopped**: stopping waits for a
  renewal in flight, and one that fires during that wait did not end the request. Read late,
  an ordinary error became the failure with no Retry, or a claim handed back for the next
  process to run again unasked. The first error ends it: there is no automatic retry, and the
  only way back to `queued` is the uploader or the host asking for it — the transcription
  retry under _Delete, retry, and the purge marker_.
- **The provider is a port with one adapter.** `TranscriptionProvider` is
  `transcribe(stream, contentType, signal)` and nothing else, bound under the string token
  `TRANSCRIPTION_PROVIDER` so a spec can substitute a fake without importing the module. The
  adapter posts an OpenAI-compatible `audio/transcriptions` request, which is what the local
  Whisper service speaks. The object is **streamed** into the multipart body, never buffered,
  so a gigabyte of video costs a chunk of memory; it goes out chunked, with no `Content-Length`,
  because nothing has measured it. The endpoint's filename is derived from the sniffed type
  (`recording.mp3`), never the user's: the endpoint routes on that extension, and the user's
  text has no business on another service's wire. Every failure is a
  `TranscriptionRequestError` the worker never quotes — the port's own type, not the pipeline's
  `StepError`, whose message is copy for a user and which this is not; the server's own words
  stay in the log, next to the model that was asked for.
- **The request is `node:http`, not `fetch`, and must not be simplified back.** A Whisper server
  sends no response header until the whole transcription is done, and Node's `fetch` waits 300
  seconds for the first one — undici's `headersTimeout`, reachable only through a dispatcher,
  which would mean taking undici as a dependency. Through `fetch`, a one-hour recording (330
  seconds of work on the machine the time limit was measured on) failed at 301 seconds with
  `UND_ERR_HEADERS_TIMEOUT`, whatever `TRANSCRIPTION_TIMEOUT_SECONDS` said. Over `node:http` the
  only bound is the `signal`. No spec can wait five minutes, so one pins that `fetch` is not
  called. Each request also gets a connection of its own (`agent: false`): a kept-alive socket
  the server closed between two recordings would fail the second with a reset. **An abort
  frees the API, not Whisper**: the server finishes the transcription it started, at full
  load, with nobody left to read the answer.
- **The local Whisper is the `whisper` Compose service — Speaches, behind the `transcription`
  profile.** Six things about it that `docker-compose.yml` can only half say:
  - **Pinned to `0.9.0-rc.3-cpu`, never `latest-cpu`.** That tag is still 0.8.3, which has no
    `PRELOAD_MODELS` and names its settings differently. Check `linux/arm64` on any bump.
  - **`TRANSCRIPTION_MODEL` must be the model the service holds** — `Systran/faster-whisper-small`,
    which is `WHISPER_MODEL` there. The server does not ignore the field: a model it has not
    downloaded is a 404, and `whisper-1` is its alias for `large-v3` and so fails every
    recording. **That is why the variable has no default**: one right for this service is
    wrong for a hosted endpoint and the other way round, and either way the failure is every
    recording, one at a time, long after boot. With transcription on and the model unset the
    process refuses to start and says so; `.env.example` and Compose carry the local name.
  - **The entrypoint wrapper is what lets it start offline.** `PRELOAD_MODELS` asks Hugging Face
    which models exist _before_ it looks at its own cache, so set unconditionally the server
    exits at start-up without the network and Compose restarts it for ever. The wrapper sets it
    only while the volume lacks the model's files and starts with `HF_HUB_OFFLINE=1` once they
    are there. It restates the image's command, so re-read it when the tag changes.
  - **It decodes MP3, M4A, WAV, MP4, M4V, and WebM itself**, which is why the API image carries
    no ffmpeg and the adapter sends the object as stored.
  - **It transcribes whatever decodes, so "damaged" is not "failed".** An MP3 cut off half-way
    comes back `transcribed` with the words that survived, and a tag and one frame header with
    nothing after them came back as the single word "you". Only bytes it cannot decode at all
    are a 415, `Failed to decode audio` — which is what `undecodableMp3` in
    `test/utils/transcription-suite.ts` is, checked against the real service.
  - **Its log says `ERROR … Unexpected streaming transcription response type` on every
    request.** That is a stray line in this release, logged before the answer is built; the
    request it belongs to succeeded.
- **The time limit is a measurement, and it lives beside the constant.**
  `src/config/transcription.defaults.ts` holds
  `DEFAULT_TRANSCRIPTION_TIMEOUT_SECONDS` with the numbers behind it: about six seconds of work
  per minute of audio, so twelve minutes covers a one-hour recording at twice that. The rate is
  the host's — re-measure rather than reason about it, through the API, from the transcription
  worker's `transcribed … in …ms` line.

## Claude (`src/modules/claude-agent`)

`ClaudeAgentService` is Claude through the Claude Agent SDK, two ways: `runPrompt(prompt, model)`
is a prompt in and text out, and `runStructuredPrompt(request, signal)` is a system prompt, a
prompt, and a JSON schema in and an object bound to that schema out, with its model, cost, and
token counts — and, when the request names them, tools of the API's own that the run may call
before it answers. No route reaches either; a feature that wants Claude imports
`ClaudeAgentModule`, and the meeting digest is the one that does.

- **The SDK is Claude Code as a library, not an HTTP client.** Each call starts a Claude Code
  process — a native binary of about 220 MB, installed as a per-platform optional dependency —
  and that process is what talks to Anthropic. By the SDK's own defaults it loads the user's
  and the project's settings and the MCP servers they configure, holds Bash and file tools, and
  inherits the whole environment. `optionsFor` takes each of those away, and every line of it
  is load-bearing: give the process a tool only together with a decision about what a prompt
  may then make it do on the API's host.
- **The environment is replaced, not inherited** — the SDK's `env` is not merged with
  `process.env`. The process gets `INHERITED_VARIABLES` and the token: not the API's secrets,
  and not the `ANTHROPIC_BASE_URL` and `CLAUDE_CODE_*` an API inherits when an agent session
  started it, which would point the SDK, configured token and all, at that session's endpoint.
  A variable the process really needs, a proxy for one, is added to that list.
- **`ANTHROPIC_AUTH_TOKEN` is the only credential, and its absence is an error, not a
  fallback.** It is optional at boot while `MEETING_DIGEST_ENABLED` is off, since nothing then
  needs it, and required with it on. Without the check in `requireAuthToken` the process would authenticate with whatever the host has — on a
  developer's machine, their own Claude login — and the call would succeed on the wrong account.
- **Never import the SDK at the top of a file.** It is ESM-only. Node 24 loads it from this
  CommonJS build regardless, but Jest fails on it with `Cannot use import statement outside a
module` unless Node runs with `--experimental-vm-modules`, and `ClaudeAgentModule` is in
  `AppModule`, so a top-level import would fail every e2e spec before its first test. The
  `await import()` inside `ClaudeAgentSdkLoader.loadQuery` runs only when a prompt is sent;
  everything else the module takes from the package is `import type`. **There is a second
  place, for the same reason**: `ClaudeAgentToolkitLoader.loadToolkit` loads `tool` and
  `createSdkMcpServer`, which describe tools and send nothing. It is the one of the two the
  module exports — a module that describes tools is not handed the means to send a prompt.
- **`ClaudeAgentSdkLoader` is the seam the service's own decisions are tested through, and
  nothing else.** The specs beside the service hand it a scripted process
  (`claude-agent-process.fixture.ts`) and hold it to what it decides around one: that nothing
  is started without a token, what a process is started with — the options and the
  environment, variable by variable — and what becomes of a call its caller hung up on. They
  say nothing about how the real process behaves; that stays `test:live`'s, because a scripted
  SDK only repeats back what a spec assumed about it. Do not bind a fake over the loader to
  give a feature's tests a Claude: those fake `ClaudeAgentService` itself.
- **A schema-bound answer fits the single turn, and that was measured, not assumed.** With
  `outputFormat` the SDK gives the model one tool of its own, `StructuredOutput` — there
  whatever `tools: []` says, and the only tool the process then holds — and the model answers
  by calling it. That call ends the turn with no second request, so `maxTurns` stays 1; the
  result reports `num_turns: 2` all the same, counting the tool's reply. The numbers are beside
  `SINGLE_TURN`. What the cap costs is the correction: an answer the SDK rejects against the
  schema has no second request to be put right in, and ends as a failure. Raise it only for
  that, and only with the process still holding no tool that touches the host.
- **A request that names `tools` is the one call that holds any, and only those.**
  `toolOptionsOf` (`services/claude-agent-tools.ts`) adds options and takes none away:
  `mcpServers` with the one in-process server, `allowedTools` with the names the caller
  listed, `maxTurns` raised to `MAX_TOOL_RUN_TURNS` or to what the caller asks for, and
  the caller's `hooks` if it names any. The process still holds no
  built-in tool, `dontAsk` still denies whatever is not listed, and `strictMcpConfig` still
  keeps `.mcp.json` out — so `allowedTools` is the whole of what a prompt can make the
  process do, and widening it is the decision the first bullet asks for. The answer is
  bound to the schema as before; on 2026-10-09 the real model called the tools and then
  answered through `StructuredOutput`, with no call denied.
- **The server is asked for as a function, and made only when a process is about to be
  started.** Making one loads the SDK. A caller that made it up front would do that in
  every e2e spec, where `ClaudeAgentService` is a fake that never calls the function.
- **Hooks are asked for as a function too, for another reason: one call of it per process.**
  A hook may count a run, and hooks made once and handed to two runs count them as one.
  **A hook is relied on only to refuse.** `deny` from a `PreToolUse` hook takes away a call
  `allowedTools` would have let through, and its reason is the model's to read in place of
  the tool's result; nothing here leans on a hook to let through what the list does not
  name. Measured on 2026-10-09 with the real model: Claude Code asks the hooks about a tool
  of an in-process server, a refused call does not end the run, and registering hooks adds
  no tokens.
- **A run stopped by its hooks needs turns past the point they stop it.** `maxTurns` ends a
  run as a failure, `error_max_turns`; a refused call only tells the model, which then
  answers. So a caller whose hooks cap the calls takes its cap from `turnsForToolCalls`,
  which is that many turns and a few more — with both at the same number, a run calling
  one tool a turn would fail on the cap in the turn before the hook had anything to refuse.
- **`num_turns` is not the count `maxTurns` caps.** A one-turn answer reports 2, and a run
  that looked for two tasks, wrote them, and answered reports 6 under a cap of 20. The cap
  was never reached in a measurement, and what it does to a run that calls tools one at a
  time for fifty tasks was not measured (`meeting-digest.defaults.ts`).
- **The structured output is `unknown`, and the caller validates it again.** The schema was
  enforced by another process on the provider's word. A caller that stores or renders the
  answer checks the shape itself, with bounds on every length.
- **`signal` hangs up, and a call that was hung up on never resolves.** The SDK takes a
  controller, closes the process's input on abort, and kills it about two seconds later — so
  the rejection trails the abort by that much, and an answer that lands inside those two
  seconds is discarded with its cost on the error. Without that, whether a time limit ended in
  an answer would depend on which side of it the last token fell. The failure is `FAILED`
  whatever the reason: the signal is the caller's, and so is knowing why it fired. The signal
  is checked three times — before the call, after the SDK has loaded, and after the result —
  and `claude-agent.service.abort.spec.ts` has a case for each; none of them is redundant.
- **What a result becomes is `outcomeOf`, a pure function with a table beside it**
  (`services/claude-agent-outcome.ts`). An API error arrives as a _successful_ result whose
  text is the error; a refused token is told by the assistant message's `error`; a prompt past
  the context window by the result's `terminal_reason` — `blocking_limit` when Claude Code
  declines to send it, which costs nothing — and never by the text beside it, which is the
  SDK's to reword. A shape the SDK surprises you with is a new row in that spec, taken from a
  real run. `ClaudeAgentError` carries the `failure` a caller branches on, a message that is
  **for the log and never for a user**, and `costUsd` whenever a result reported one: an
  answer that could not be used was paid for all the same.
- **What a run spent is told to its caller as the result arrives, not only with the answer.**
  A request's `onSpend` is called from inside the loop that reads the process
  (`readExchange`), with the result's cost and its tokens in and out — before the signal is
  checked the third time and before `outcomeOf`, so a result that is then refused, or
  discarded as too late, has been reported all the same. A process killed before its result
  reports nothing: there was no cost to read. **It is there for a log and must not throw** —
  a throw is caught as the process having stopped, and the result is lost with it. A
  stand-in for `ClaudeAgentService` never calls it, so neither e2e suite's log has a cost
  line.
- **Input is billed at the cache-write rate, a quarter above the listed one.** Claude Code
  marks the prompt for Anthropic's prompt cache, and a one-turn call never reads it back.
  The measurements are in `src/config/meeting-digest.defaults.ts`.

Its one caller is `MeetingDigestGenerator` (`src/modules/meeting-digests`): transcripts in, a
validated digest out, one run that is handed the meeting's tools (_Tasks, and the run's
tools_, below). What calls the generator, and what is done
with its answer, is the next section. The PRD is
[`docs/prd-meeting-digest-summary-action-items-decisions.md`](../../docs/prd-meeting-digest-summary-action-items-decisions.md)
and the decisions under it are in
[its plan](../../docs/plan-meeting-digest-summary-action-items-decisions.md). Six things about
it that read like omissions:

- **The transcripts are sent whole or not at all.** Past `MAX_DIGEST_TRANSCRIPT_CHARACTERS`
  the prompt builder throws and nothing is sent; nothing is ever cut to fit or summarised in
  parts, because a digest of part of a meeting would be shown as the digest of the meeting.
  The cap counts characters — tokens cannot be counted without asking Anthropic — so a denser
  script can pass it and be refused by the model, which ends in the same failure.
- **A transcript is not escaped, and the answer is not cleaned.** What was said goes into the
  prompt as it was said, markup and text addressed to the model included; the instructions are
  what keep it from being obeyed, and `test:live` holds the real model to that. So a
  transcript can hold a `</recording>` of its own, which is why the instructions call the
  _whole user message_ transcript rather than "what is inside a recording", and why the
  injection fixture speaks from outside one. The guard keeps markup as the characters it is:
  the digest is rendered as text, and the place that renders is the place that knows what is
  safe.
- **A blank transcript is sent, and only no transcript at all is refused.** Whisper
  transcribes silence as empty text, and that recording is still one of the meeting's. The
  instructions say what the digest of recordings with no speech is — a summary that says so,
  and two empty lists — so a caller has one behaviour to rely on and this code never writes a
  summary of its own. A caller that would rather not pay for it decides that for itself.
- **A list past its bound is cut, and the summary says so.** `MAX_DIGEST_ITEMS` is fifty of
  each; a meeting that states more gets the most important fifty and a closing sentence that
  the list is not complete, because part of a list shown as all of it is the PRD's "part
  presented as the whole" in small. The answer has no field for it — the sentence is the
  model's, in the summary — and a model that returned all sixty instead would fail the call,
  there being no second turn to cut them in. `test:live` measured that it does not.
- **An owner in the answer is a name and can be nothing else.** The schema has no field for a
  user and the guard refuses an answer with an extra one, so no answer can point at a
  participant. Linking a name to one is the API's decision, made from the meeting's members.
- **The guard is all or nothing.** One unfit field refuses the whole answer, and its `problem`
  names a path and a rule without quoting the answer — it is for a log.

The cap and the time limit's default are measurements, stated with their numbers beside
`DEFAULT_MEETING_DIGEST_TIMEOUT_SECONDS`. Re-measure when the model changes, **and whenever
the instructions do**, since they are part of every prompt: `MEETING_DIGEST_MEASURE_CHARACTERS`,
`MEETING_DIGEST_MEASURE_RUSSIAN_CHARACTERS`, and `MEETING_DIGEST_MEASURE_OUTCOMES` switch on
the runs of `test:live` that are too expensive to be on by default
(`test/meeting-digest-measure.live-spec.ts`, which says what each costs).

## Meeting digests (`src/modules/meeting-digests`)

A meeting's summary, action items, and decisions, generated from the transcripts of its
recordings, stored, and served at `GET /api/meetings/:id/digest`. The contract is
[the PRD](../../docs/prd-meeting-digest-summary-action-items-decisions.md); every decision
under it, and the phases, are in
[its plan](../../docs/plan-meeting-digest-summary-action-items-decisions.md). **All seven
phases are built**: a recording that reaches Transcribed gives its
meeting a digest, anyone who can see the meeting can read it, a deleted recording takes away
what was built from it, every change is sent to the meeting's open streams, an action item's
owner is reported as the member of the meeting the spoken name identifies, and the host or
a transcribed recording's uploader can retry a digest that failed —
`POST /api/meetings/:id/digest/generation`. The meeting page shows the digest, follows
it over the stream, and is that route's one caller: "Retry" in the digest's section
([the web guide](../web/AGENTS.md#the-digest)). **Phases 5 and 7 built more than that, and
it has since been taken back**: a "Generate digest" for the digests no recording would ask
for again. Those are now asked for at boot, with nobody pressing anything (_Catching up_,
below); the plan is left as the record of what was built first.
What a reader of the code would get wrong:

**What leaves, and when**

- **Switched on, it sends transcript text to Anthropic — which the transcription PRD ruled
  out, and is why `MEETING_DIGEST_ENABLED` ships off.** What is sent is what was said, under
  an ordinal: no file name, id, email address, display name, or storage path, and an e2e
  spec reads the captured prompt to hold it to that. Give the prompt a field only together
  with a decision about that field leaving the deployment. **That includes the members'
  names**, which would help the model spell an owner and are read only after it has
  answered (_Owners_, below).
- **One identifier does leave: the meeting's id, in the system prompt.** The run's tools
  take a meeting id, so the model is told which meeting it is — in the instructions, never
  in the user message, which stays transcript. It is a random UUID that means nothing
  outside the deployment, and that decision was the owner's, made on 2026-10-09. What the
  tools answer leaves too: the titles, ids, and statuses of this meeting's tasks, which
  were made from these transcripts. The e2e spec that reads the captured prompt holds the
  line at exactly that: the id once, in the instructions, and nothing else.
- **The setting stops new work and nothing else**, as the transcription's does. Off, a newly
  transcribed recording asks for nothing, the worker claims nothing, and a `QUEUED` row
  waits; a stored digest is still served, and both rules about recordings still apply to it,
  because the read applies them. The retry route answers 409 and the read offers no
  `availableAction`. The handlers, the worker, the catch-up, and the read ask
  `ConfigService` when they run, so the e2e suite flips it between tests. **What was
  transcribed while it was off is generated when it comes back** — not by the switch, which
  nothing watches, but by the boot that makes it: the catch-up asks for every digest a
  meeting is owed (_Catching up_, below).
- **So the first boot with it on sends Anthropic the transcripts of every meeting that has
  a recording and no current digest** — one paid generation each, with nobody asking. That
  was the owner's decision, on 2026-10-10, in place of a "Generate digest" somebody had to
  press per meeting. Whoever switches the setting on for a deployment with history is
  deciding that for all of it at once, and the README and the example env file say so.
  **It also puts that history in the API's log**: each generation runs under the tools'
  `auditLog`, which writes a task's title, a summary, and decisions at `log` level
  (_Meeting tools_, below) — per generation as it always did, and now for every meeting a
  boot catches up.
- **With it on, a missing `ANTHROPIC_AUTH_TOKEN` stops the boot** — its presence, never
  whether Anthropic accepts it. A refused token fails a digest, not the process that serves
  every upload.

**The row**

- **One row per meeting, and its status and its content are two things.** `status` is where
  the _latest_ generation stands; the summary and the three child tables are what the last
  _successful_ one stored. A generation that fails leaves the content where it was, so a
  digest can be `failed` and readable at once — the PRD's "if that replacement fails, it
  stays, with the failure". The edges, and what takes each, are the table in
  `services/meeting-digest-status.ts`.
- **`requested_revision` is the whole of a request.** `MeetingDigestRepository.request` is one
  upsert that bumps it. A claim remembers the revision it took, and the write that ends it is
  `READY`, `FAILED`, or no status only if the revision has not moved — `QUEUED` otherwise.
  All three go through `settle`, so a fourth way to end a claim gets the condition by being
  written there. That is all of
  "never two generations at once, and one more after a change": a request made while a
  generation is out changes no status, takes no lock, and tells the worker nothing.
- **Every fresh request resets the claim count, and so does a requeue.** `attempts` bounds
  the crashes of one generation, not the life of a row: three recordings arriving one behind
  another are three generations, and counting them as claims would fail the fourth unrun.
- **Content is stored even when the row goes back to `QUEUED`.** An answer that arrives after
  another request is still a whole digest of the recordings it names as its sources. The
  read marks it out of date until its replacement lands.
- **`version` rises with every change to what `GET` answers, and a lease renewal is not one.**
  It is what orders an event against an event or a fetch: a client keeps the higher of two.
  **Two writes exist only to move it** — a recording transcribed with the setting off, and a
  deleted recording the digest was not built from. Neither changes a column; both change
  `outOfDate`, which the read derives. An answer that changed under an unchanged version is
  one a page holding the old answer has no reason to take. **Two changes do that all the
  same**, each said where it is made: a linked owner's new name (_Owners_), and an
  `availableAction` that left with a recording nothing reacted to the delete of (_Retry_).
- **The raw statements set `id` and `updated_at` themselves.** `@default(uuid())` and
  `@updatedAt` are the Prisma client's, and the request and the claim do not go through it —
  hence `gen_random_uuid()`, `now()`, and a database default on `updated_at`.
- **`@@index([meetingId])` beside `@unique` is deliberate**: `.claude/rules/prisma.md` asks
  for an index on every foreign key by that name. The unique constraint is what `ON CONFLICT`
  names.

**The read**

- **Both of the PRD's rules about recordings are derived on every read**, in
  `toMeetingDigest`, from the digest's sources against the recordings transcribed now:
  content is returned only while every source is still one of them, and is `outOfDate` when
  one of them is not a source. So they hold with the setting off, before anything has reacted
  to a delete, and in whatever order events arrive. Do not replace them with a column
  somebody has to keep true.
- **The digest row is read before the recordings**, and the order is the point: a recording
  deleted between the two reads is already missing from the second, so its words are
  withheld. The other way round, that delete would be served.
- **The row and its three tables are read in one `REPEATABLE READ` transaction.** They are
  four statements, and at the default isolation each sees what had committed when it began:
  a generation landing between two of them gave a read the earlier summary over the later
  action items. `complete`'s transaction is only half of "never half a digest"; this is the
  other half. They are four awaited reads rather than one `include` because Prisma sends an
  include's statements to a transaction's one connection together, which `pg` deprecates.
- **A meeting with no digest is a 200 with `version: 0`**, not a 404 — the 404 is "you cannot
  see this meeting", and one shape is all a client has to read.
- **`MeetingDigestsService.currentOf` is the read without the question of who is asking**,
  and `findOne` is the visibility check in front of it. An announcement has no user: it goes
  to streams whose guard has already decided. One method for both is what makes an event the
  answer `GET` would give — an owner's current name reaches the stream by being read there,
  and `availableAction` by being decided there, and nowhere else. `describe` is its second
  half, for a caller that already holds the row: the retry route answers with the row its
  own write left.

**Owners**

- **Claude answers a name; which member it is, is decided here, after the answer.**
  `matchOwner` (`services/meeting-digest-owner.ts`) links a spoken name to a member when
  every word of it is a word of exactly one display name among the host and participants,
  compared without case. A word is a run of letters and digits, which is what lets a name
  nobody chose — `ada.lovelace`, derived from an address — take part. **Nothing in it is
  approximate**: no prefix, no initial, no dropped accent, no other script. A wrong owner is
  worse than none, so a first name two members share links to neither.
- **The members are read once the answer is in hand** — inside `runDigestGeneration`, under
  its heartbeat, and only for an answer that is going to be stored. That order is why no
  name is in the prompt.
- **Members that cannot be read link nobody; they do not fail the digest.** That is the
  opposite of an answer whose recordings cannot be checked, on purpose: storing those
  unchecked could serve a deleted recording's words, while an owner left as the name that
  was spoken is what the PRD prefers whenever a match is in doubt — and failing would throw
  away a generation that was paid for. `ownerLinksOf` logs the cause and never rejects; the
  names stay unlinked until the meeting's next generation.
- **An owner is two columns: `owner_name`, always, and `owner_id`, when it matched.** The id
  is written from the match and from nothing in the answer, whose schema has no field for
  one. The name stays for the day the link is gone (`onDelete: SetNull`), when the item is
  still somebody's.
- **The read asks what each linked member is called now** — one `FindUsersByIdsQuery` for
  all of a digest's owners, none for a digest that links nobody — so a rename shows with no
  generation and no write. **It does not move `version` either** — one of the two changes
  to what `GET` answers that do not: nothing tells this module a user was renamed, so an
  open page keeps the old name until its next fetch. Closing that takes an event from the
  user module, not a column here.
- **This is the only place a user's display name is shown to another user**: to the members
  of a meeting, for the members its digest links, on `GET …/digest` and on the `digest`
  event that is the same answer — an id and a display name, never an email address. What
  bounds it is that the ids come from the digest's own rows, matched from the meeting's
  members, and never from a request. **It leans on a meeting's participants being fixed at
  creation**: the day one can be removed, their links have to go with them, or the read has
  to ask who is still in the meeting.

**Deleted recordings**

- **`WithdrawDigestWhenDeletedHandler` is tidying on top of the read, not what the rule
  rests on.** `GET` withholds a digest from the moment the delete commits. What the handler
  adds is that the words leave the tables, that a replacement is generated with nobody
  asking, and that open pages are told. So a reaction that fails is logged and not retried,
  and it runs with the setting off: the setting only decides about the replacement.
- **What a delete does is one decision, `digestAfterDelete`, and one transaction.** Content
  one of whose recordings is gone is removed — whichever file the event named, so a delete
  whose reaction never ran is caught up with by the next. Then a replacement is asked for,
  when the setting is on and a transcribed recording is left, or the status is cleared. With
  no transcribed recording left there is no digest whatever the row said, `GENERATING`
  included: that generation finds its claim gone, and its answer is not written.
- **Clearing a `GENERATING` row does not hang up on its call at once, and that is accepted.**
  The worker finds the claim gone at its next lease renewal, a third of the lease away. One
  replica runs one loop, so nothing starts meanwhile; with two, a recording transcribed in
  those seconds queues a row the other may claim while the first call is still open — one
  call paid for and discarded, nothing wrong stored. It is the lapsed-lease overlap reached
  sooner; the plan's decision 8 has what closing it would cost every other digest.
- **Following a delete is `MeetingDigestDeleteFollower`'s, for both of its callers** — the
  event handler, and the worker's second look below. The order of its steps is its
  correctness, which is why there is one copy of them.
- **The revision is read before the recordings, and a clear gives way to a request made
  since.** A recording transcribed after the recordings were read is not among them, and its
  request moved the revision; clearing regardless would leave a meeting with a recording and
  nothing queued. **The row is locked before its sources are read**, which orders the
  transaction against a generation's `complete` — without the lock it could remove the old
  content's rows and blank the summary of the new content that landed between.
- **Every `deleted` is listened to, a PDF's and the purge's repeat included**, because which
  recordings a digest was built from is this module's to know: the event carries the file as
  its delete read it. A meeting with no digest row costs one indexed read. The purge is
  indistinguishable from the delete, and the one thing it repeats is the version of a digest
  that was not built from the recording — an event carrying what the page already holds.
- **The one thing read from the event is whether the file had a transcription status at
  all — never which.** A status is given by the write that makes a file `ready` and the
  delete is conditional on the status it read, so "had one" cannot be stale; "transcribing"
  can, for a recording transcribed between the delete's read and its write. Any recording's
  delete is therefore followed as one that may have taken the out-of-date mark with it, and
  a version sometimes moves for nothing. Gate it on `transcribed` and that flip of
  `outOfDate` goes out under the version a page already holds.
- **The worker discards an answer one of whose recordings was deleted while Claude wrote
  it.** `runDigestGeneration` asks which recordings are transcribed once the answer is in
  hand, and reports `sourceDeleted` instead of sources; `DigestOutcomeRecorder.discard`
  hands the claim back as a shutdown does, queued and uncounted. A check that cannot be
  made fails the digest (`SOURCES_UNCHECKED`, the generic sentence) rather than store
  unchecked.
- **And it looks again once the answer is stored, which is not a repeat of the first look.**
  The first cannot see a delete in progress, and one that commits just after it can be
  followed _before_ the answer lands: that reaction finds none of the answer's sources and
  changes nothing, and the answer is then stored naming a deleted recording, with nothing
  queued. `MeetingDigestDeleteFollower.recheckStored` reads the recordings after `complete`
  committed and follows the delete itself if one is gone. One of the two always sees the
  other: a delete committed before that read is missing from it, and one committed after it
  has its own reaction lock the row after the answer was stored. Drop either look and an
  order is uncovered — the first also keeps a deleted recording's words from being written
  at all in every order but that one.
- **One gap is left on purpose.** A claim that finds no transcribed recording clears the
  status and leaves the content rows, as phase 2 built it; they are withheld, and removed by
  the next delete in the meeting. It is reached only when a delete's reaction never ran.

**Tasks, and the run's tools**

- **A generation keeps the meeting's tasks while it writes the digest.** The run is handed
  `MeetingTools`' server for its meeting with all three tools allowed, and the instructions
  (`buildMeetingDigestInstructions`) carry three rules `test:live` holds the real model to:
  look with `find_tasks` before creating a task; update the similar task that is found
  rather than add a second; leave alone whatever is not a task.
- **Tasks are written during the run, not with the answer.** Nothing about them waits for
  `complete`, so a generation that fails, runs out of time, is handed back at a shutdown,
  or is discarded for a recording deleted meanwhile has still written what it wrote — and
  the generation that replaces it finds those tasks and updates them. **Nothing takes a
  task back**: one made from a recording that is later deleted stays. The digest's rule
  about deleted recordings does not cover tasks, and no route serves a task yet; the route
  that does has that to decide.
- **`update_meeting` is allowed in the run, and it is the one tool that can break a rule
  here.** A revision writes at once, before the answer is checked against its recordings,
  and outlives the run that made it: one that then fails leaves a summary no generation
  completed, and one discarded for a deleted recording leaves words of that recording under
  sources that never named it — which no delete withdraws. Allowing it was the owner's
  decision, on 2026-10-09. What holds it back is the instructions, which tell the model the
  answer is stored for it; on a meeting's first digest the tool answers `NO_DIGEST` and
  nothing is written. Taking it out is one name fewer in the generator's `toolNames`.
- **A run's use of the tools is bounded by hooks, not by the instructions.**
  `MeetingHooks.createHooks` is made for every run and registered through the request's
  `tools`: a title too short to be a task is refused, every call past
  `MEETING_DIGEST_MAX_TOOL_CALLS` (20) is refused, and each call that ran is logged
  (_Meeting tools_, below). **A generation that runs out of calls still stores its
  digest** — the answer is not one of the calls — **and its tasks only in part**: at two
  calls a task, twenty is ten tasks. The turn cap follows the budget (`turnsForToolCalls`,
  under _Claude_).
- **The model is told the budget, in the instructions, and that is what makes it usable.**
  `buildMeetingDigestInstructions(meetingId, maxToolCalls)` says how many calls the run has
  and how many tasks that is, most important first. Told nothing, a model with many tasks
  searches for all of them before it writes one — it batches its calls — and a budget
  spent on searches leaves a digest with no task at all. The generator reads the number
  once and hands the same one to the instructions and to the hooks; the contract's floor
  is two, one task. `test:live` holds the model to both halves: a budget of two records
  one task with no call refused, and hooks made to allow one call under instructions that
  promise twenty refuse the second and still get their digest.
- **What the instructions say about ids is not what keeps a run to its meeting** — the
  server does (_Meeting tools_, below).
- **One e2e spec runs the tools through a generation, and it is the one about injection.**
  Everywhere else both suites' Claude is a stand-in for `ClaudeAgentService` that never
  asks for the server. In `test/meeting-digest-injection.e2e-spec.ts` the stand-in is a
  model that a transcript has taken over completely: for the meeting id the transcript
  names it searches, plants a task, closes a task, and rewrites the summary, through the
  server the generator made, against the database. Nothing of the other meeting is read or
  changed. **It asserts what happens when the model obeys, not that it refuses** — whether
  the real model refuses is the instructions' and `test:live`'s. The tools alone against
  the database are `test/meeting-tools.e2e-spec.ts`.
- **A generation that writes tasks is three requests where there was one**, about five
  times the tokens the same meeting read before there were tools, and twice the seconds;
  the rows are in `meeting-digest.defaults.ts`. A meeting with fifty tasks was not measured
  with tools, and the time limit was set before there were any.

**Revision**

- **`ReviseMeetingDigestCommand(meetingId, summary, decisions)` is the one write to a
  digest's content that is not a worker's under its claim.** It puts a summary and decisions
  in place of the stored ones; its caller is the `update_meeting` tool
  (`src/modules/meeting-tools`), and it carries no user — whether the caller may touch the
  meeting was decided by whoever handed it the command.
- **It revises a digest and cannot make one.** The write is conditional on stored content,
  and a meeting without any answers `NO_DIGEST`: content is served only while every
  recording it was built from is still transcribed, so a summary stored under no recording
  would be one no read returns.
- **Action items, sources, `generated_at`, and the status are left as the last generation
  left them.** The revision is therefore still attributed to that generation's recordings —
  deleting one withdraws it with the rest — and a generation that is queued or under way
  replaces it when it lands, as it replaces everything. It takes no edge of the status
  table.
- **`version` moves and the change is announced**, like every write that changes what `GET`
  answers.
- **Its bounds are the answer's, enforced by the answer's guard** (`readMeetingDigestRevision`):
  what bounds a row must not depend on which way the text came.
- **The setting is not asked about.** It decides whether transcripts leave the deployment,
  and a revision sends nothing.

**Retry**

- **`POST :id/digest/generation` is the one request for a digest that a person makes, and
  the one caller of `FAILED → QUEUED` that no recording caused** —
  `RetryMeetingDigestCommand`. Everything else that queues a digest is a recording being
  transcribed or deleted, or the boot's catch-up. The path still says `generation`: that is
  what a retry asks for.
- **The gate, its order, and its 404s are the transcription retry's**: a meeting the caller
  cannot see, then a caller who is neither the host nor the uploader of one of its
  transcribed recordings — another participant included — each the 404 a guessed id gets.
  The 409s come after, so only someone who could have asked ever learns what the digest or
  the deployment refuses.
- **One rule decides what the read offers, what the route accepts, and what the catch-up
  asks for: `requestabilityOf`** (`services/meeting-digest-action.ts`). No transcribed
  recording refuses everything; a failed digest is a person's to retry; anything else is
  owed a digest — the catch-up's to ask for — unless it is queued, generating, or built
  from exactly the recordings transcribed now. Each caller is answered through
  `requestabilityFor`, which makes what is the other's a refusal: the mapper reports
  `availableAction` only where a retry is allowed, the route answers a digest that is owed
  and has not failed with a 409 of its own, and the catch-up leaves a failed one alone.
  Change the rule there and nowhere else.
- **This request can be refused, and a transcribed recording's cannot — on purpose.** A
  recording that arrives while a generation is out is "one more after it". A person pressing
  a button over a digest that is queued, generating, or current is asking for a second paid
  request for the same recordings, and gets a 409.
- **It is decided under the row's lock** (`requestGenerationAs`, as a retry), which is what
  makes two retries at once one generation, and orders the decision against a generation's
  `complete`, as a delete's is ordered. **It makes no row to lock**: a meeting with no row
  has no failure to retry, and a row made for a request that is then refused would be
  committed with the refusal. What is then written is `requestGeneration`, like every other
  request: the claim count back at 0, the reason cleared, the content left alone.
- **The recordings it is decided against are read before that lock, and moving the read
  under it is not the fix it looks like.** A recording deleted in between can let through a
  request for a digest the delete has just made current — and leaves the row where the same
  request committing just _before_ the same delete leaves it, `QUEUED` over current
  content, because a delete takes no request back. Asking `meeting-files` from inside the
  transaction would buy nothing but a second connection wanted by every transaction that
  holds one, which empties the pool at as many requests at once as it has connections.
- **The setting is asked about after the gate and before the write, and that is not the
  transcription retry's answer.** That route queues with its setting off, to wait for it.
  A digest queued while nothing is generated would be a paid request made the day somebody
  switches the setting on, by nobody — so off is a 409, and `availableAction` is absent.
- **No failure is refused a retry**, where the transcription's refuses the time limit: a
  generation that was hung up on is a process the SDK has killed, not a Whisper still
  running, and transcripts that are too long fail again unsent, at no cost.
- **It answers the row as its own write left it** — read inside the transaction, before
  the lock lets a worker at it — because answering `generating` would say the request did
  something it did not. The claim's event carries a higher version.
- **`availableAction` is the same for every reader**, and so for every stream: it says what
  the digest allows, not whether this reader may ask. Who is shown the control is the
  page's to work out from the files it holds.
- **It is the second thing that can change under an unchanged `version`.** When the last
  transcribed recording of a meeting whose digest failed is deleted and nothing reacts to
  the delete, Retry is no longer offered and nothing was written — the reaction is what
  would have cleared the status and moved the version. The page is expected to offer the
  action only while its own files list holds a transcribed recording, and to answer a 409
  by fetching the digest again. A setting that changed is a restart, which ends every
  stream and so has every page fetch.

**Catching up**

- **`MeetingDigestCatchUp` asks, once at boot, for every digest a meeting is owed and
  nothing else will ask for.** While a process runs, the one thing that asks is a recording
  being transcribed, and a meeting is left owed a digest all the same: its recordings were
  transcribed while the setting was off, or before there was a digest; the request after a
  transcription was lost with its process, or failed; a delete emptied the digest with the
  setting off, or was never followed. Each of those used to wait for somebody to press
  "Generate digest". The owner's decision of 2026-10-10 was that nobody should have to.
- **It is a boot's, not a timer's, and that leaves one gap on purpose.** A change of the
  setting is a boot, and so is the restart after a crash — between them every case above
  but one: a request whose write failed in a process that went on running waits for the
  next boot, or for the meeting's next transcribed recording. A periodic sweep would close
  it for the price of two whole-table reads on a timer in every replica.
- **A failed digest is never caught up.** Its way forward is Retry. Asked for again at
  every boot it would be the automatic retry nothing here makes — one per restart, in a
  deployment that is crash-looping.
- **Two looks, and only the second decides.** The first is two statements — every digest's
  standing (`findStandings`, which reads whether a summary is stored and not its text)
  beside every meeting's transcribed recordings — and is a list to skip by: a boot with
  nothing owed costs those two and no more. Each meeting it lets through is then asked
  about on its own, **with its recordings read again**: the first look is stale by a
  meeting's turn, and a recording deleted or transcribed meanwhile would have a digest that
  is current asked for again. Then `requestGenerationAs` decides, as the catch-up, under
  the row's lock.
- **That lock is what makes two replicas booting one generation, and a meeting with no row
  is given an empty one to take it on.** `ON CONFLICT DO NOTHING` waits for the other
  transaction, and the lock then shows this one what that one wrote. The empty row never
  outlives the transaction: a row with no status and no content is always owed a digest,
  and a meeting with no recording was refused before it.
- **It ends because a digest it caused is, to the next catch-up, current.** A generation's
  sources are what the one-meeting recordings read answered, and "current" is those
  against the every-meeting read — which is why the two share their conditions (_The third
  boundary_). `meeting-digest-catch-up-races.e2e-spec.ts` holds a second run to asking for
  nothing.
- **Two orders still cost a generation that was not owed, and both are accepted.** A
  recording transcribed within moments of the boot asks unconditionally, so if a worker
  claims the catch-up's request before the recording's lands, the recording's is "one more
  after it", over the same recordings. And a digest another replica is generating is passed
  over as under way; if that generation began before a recording whose own request was
  lost, it ends ready and out of date until the next boot.
- **It runs where the worker polls, and the boot does not wait for it.**
  `onApplicationBootstrap` starts it only with `MEETING_FILES_WORKER_ENABLED` and the
  setting both on, and un-awaited — `listen` must not wait behind a backlog — held by
  `PendingDigestRequests` for shutdown and for `drain()`. It asks about one meeting at a
  time, since each is a transaction and a backlog asked about at once would be the pool
  emptied at boot; it looks at the setting and at shutdown before each; it never rejects;
  and it logs how many meetings look owed **before it asks for the first** — each being a
  paid request nobody made, the count is what somebody watching a first boot can still act
  on — and how many it asked for once it has. Under `nest start --watch` it runs at every
  save, which with nothing owed is the two reads.
- **The hook asks the query bus, and the handlers have to be registered by then.**
  `CqrsModule` registers them in its own `onApplicationBootstrap`, and Nest runs that hook
  for a module deeper in the import tree first — which `CqrsModule`, imported by this one,
  always is. Were that order ever lost, the failure would be one caught and logged line and
  a catch-up that silently asks for nothing; `meeting-digest-catch-up-boot.e2e-spec.ts`
  boots an application over an owed meeting and is the spec that would notice.

**Announcements**

- **`MeetingDigestAnnouncer` is the one publisher of `MeetingDigestChangedEvent`**, called
  by whoever has just committed a write: the two request handlers — a transcribed
  recording's, and Retry's — the catch-up, the delete follower, and the worker's recorder on
  the branch where its conditional write landed. A write that lost its claim changed nothing
  and announces nothing, as a refused request does. A new write to the row owes a call to
  it — and, if it changes what `GET` answers without changing a status, a version to
  announce it under.
- **It reads the digest again instead of being handed one**, so an event is a snapshot at
  least as new as the write it follows, and sometimes newer: two writes close together can be
  announced as the same digest twice. That is harmless to a client that keeps the higher
  version, and is why nothing here tries to pair an event with "its" write.
- **The worker waits for the announcement of its claim before it asks Claude.** Started and
  left behind, that read would as often find the answer a quick generation had already
  stored, and no page would ever be told "generating". It costs a few reads per generation.
- **It never rejects.** The write is committed; a read that fails costs the open pages one
  event, repaired by the fetch they make when their stream next opens, and must not fail a
  generation or undo a request.

**The trigger and the worker**

- **The trigger is the file event, not the transcription's transaction.**
  `RequestDigestWhenTranscribedHandler` asks for a digest when a file is announced `ready` and
  `transcribed` — the one event a file in that state is ever announced with. With the setting
  off it asks for nothing, and moves the version of a stored digest instead, which that
  recording has just made out of date. The request is a
  second write, after the first committed, so a process killed between them leaves a
  transcribed recording with nothing queued: exactly the state of one transcribed with the
  setting off, and left the same way — by the next boot's catch-up. A request that fails is
  logged and not retried, for the same reason. Closing the window would mean `meeting-files`
  writing this module's table.
- **`PendingDigestRequests` exists because the bus does not wait for a handler.** It holds
  what the two handlers have started — a request, a delete being followed, and the
  announcement after each — and the boot's catch-up, which nothing awaits either: for
  shutdown, which must not close the connection under one, and
  for `drain()`, which waits for them before it looks for work. A handler registers its
  work before its first `await`, and that has to stay so: the bus calls it inside
  `publish`, which is what makes "the transcription worker has drained" imply "the request is
  one `settled()` waits for".
- **The worker is the transcription worker's shape, on this module's row**: a polling loop of
  its own where `MEETING_FILES_WORKER_ENABLED` is on, one `SKIP LOCKED` claim, the heartbeat,
  a fourth claim failed unrun, a shutdown that hands the claim back uncounted from
  `onModuleDestroy`, and `drain()` under the string token `MEETING_DIGEST_WORKER`. It runs
  under the files worker's `MEETING_FILES_LEASE_SECONDS` and `MEETING_FILES_POLL_MS`: a
  second pair of variables would only ever be set to the same values.
- **What hung up on a generation is read from the signal's reason, not from two flags.** The
  SDK's rejection trails an abort by up to two seconds, so by the time it arrives both the
  time limit and a shutdown may have fired; an `AbortSignal.any` carries the reason of the
  first, and that one ended the call. Two flags would hand a generation that timed out back
  to the queue whenever a deploy landed in those two seconds, to time out again.
- **A claim that finds no transcribed recording clears the status** — no call, no failure,
  no retry: the meeting has no digest. **Unless a request was made since the claim**, which
  leaves the row `QUEUED` instead: a recording transcribed after the worker looked asked
  while the row was `GENERATING`, and its request changed nothing but the revision. A claim
  that finds the transcripts past the cap fails as too long with nothing sent.
- **Failures store copy, never causes**, as everywhere: four sentences from `@repo/shared` —
  generic, the time limit, too long, repeated attempts — chosen in
  `processing/meeting-digest-failure.ts` from what ended the generation. The SDK's and
  Anthropic's words stay in the log. **There is no automatic retry**: every generation is a
  paid request, and the first error ends it — a failed digest is the one state the boot's
  catch-up leaves alone, for that reason. That includes an answer the database will
  not store — a NUL in its text is enough: `DigestOutcomeRecorder.complete` records the
  generic failure rather than let the claim lapse and the meeting be sent, and paid for,
  twice more.
- **The log is the only place a generation's cost is kept, and one line keeps it.**
  `MeetingDigestGenerator` writes it when the run's result arrives — the meeting's id, what
  the SDK says the run cost, and its tokens in and out — before anything is made of the
  answer, so a run whose answer is stored, refused, discarded, or lands under a lost claim
  is logged the same way, once. **The worker's lines carry no cost**: they say how a
  generation ended, with its duration and its model, and the meeting's id is what ties them
  to the cost line. Put a cost back on one of them and a request is counted twice by
  whoever sums the log. A call hung up on before its result leaves no cost line, having
  reported none. No row holds a cost and no response carries one.

## Tasks (`src/modules/tasks`)

A task is one thing to be done that came out of a meeting, stored as a record of its own:
`tasks`, with a title, the meeting it came from, and a status. **It is not a digest's action
item and nothing links the two** — `meeting_digest_action_items` are replaced whole by every
generation that succeeds, which is exactly why they cannot carry a status, and they are
still what the digest stores and serves. **A task has no assignee, on purpose**; an action
item's owner is not one.

The module is `TaskService` and nothing else: no controller and no command. It exports the
service for the two modules that hand it to an agent — `meeting-tools`, which offers the
search and the upsert to a digest's run as tools, and that module's stdio twin, which
offers all four methods to a signed-in user's client outside the process, as tools and
resources; no route reaches a task.

- **`upsert` is keyed on the meeting and the title**, as given: the model's one `@@unique`
  is the `ON CONFLICT` target. A reworded title is therefore another task, and the caller
  normalises a title before it gets here, as a DTO does for everything else. A status that
  is not passed is not written, so stating a task again does not reopen it.
- **`search` is trigram similarity, not a substring match**: `pg_trgm`'s `%` over the whole
  title or `<%` over a stretch of it, at Postgres' default thresholds, best first, at most
  `TASK_SEARCH_LIMIT`. **It searches every task, whoever asks.** A route that answers with
  it has to narrow it to the meetings the caller can see first — `visibleTo` in `meetings`
  is that rule.
- **A title's bounds, `MIN_TASK_TITLE_LENGTH` and `MAX_TASK_TITLE_LENGTH`, are the
  caller's to enforce**, like its trimming. The first is what tells a task from a fragment.
  The second is there because the title is half of a unique index, and PostgreSQL refuses
  an entry past a third of a page.
- **`open` and `get` are the two plain reads, through the client**: a meeting's tasks that
  are still `OPEN`, the oldest first, at most `OPEN_TASKS_LIMIT` — a bound at all because a
  member's client can add tasks without limit and the list is one answer — and one task by
  its id, `null` for none. **`get` answers whichever meeting the task came out of, as
  `search` does without a meeting**: an id is not a secret, so a caller that answers
  anybody checks `sourceMeetingId` before it does, and hands it a UUID — the column is
  one, and the client raises on anything else.
- **`search` and `upsert` are raw SQL, so the unit spec shows only what they are given.** What they match and
  write is `test/tasks.e2e-spec.ts`, which CI does not run.
- **`pg_trgm` is created by the migration, by hand.** Prisma does not manage extensions
  here, so nothing in `schema.prisma` says the trigram index needs one, and a database built
  any other way than by the migrations has no `gin_trgm_ops`. It also depends on the
  database's character type: under a `C` one `pg_trgm` drops every letter that is not ASCII,
  and a Russian title matches nothing. The Compose database is `en_US.utf8`.

## Meeting tools (`src/modules/meeting-tools`)

`MeetingTools.createServer(meetingId)` answers with an MCP server named `meeting` that lives
in this process and holds three tools over the API's own data: `find_tasks` and `upsert_task`, which
are `TaskService`'s two methods, and `update_meeting`, which is the digest's revision
(_Revision_, under _Meeting digests_ above). Each is described with the SDK's `tool` over a Zod
shape, and the three are gathered with `createSdkMcpServer`.

- **A server is made for one meeting, and its tools reach no other.** `createServer`
  takes the meeting's id. `find_tasks` searches that meeting's tasks, and the two that
  write refuse any other id with an error — in the handlers, whatever a run's instructions
  say. The ids are arguments, so the model chooses them, and what the model reads is what
  people said: without this a transcript naming another meeting could write there, and
  `find_tasks` would hand one meeting's tasks to a digest another meeting's members read.
- **Its one caller is the digest's generation**, which hands every run the server of the
  meeting it is generating for and allows all three tools (_Tasks, and the run's tools_,
  under _Meeting digests_).
- **Only `find_tasks` carries `readOnlyHint`.** It is a hint to whoever decides permissions,
  not a restriction: what keeps a read-only run read-only is `allowedTools`.
- **The Zod shape is the DTO.** It trims, refuses blanks, and holds every text and list to
  the bounds of what it is written to — the task's title bound and the digest's own
  constants — so `TaskService` is given a title already normalised, as it expects. The SDK
  checks an input against the shape before the handler runs, and the digest's handler holds
  its revision to the same bounds again, because it owns the row.
- **A tool never throws.** A thrown error's message is the SDK's to hand to the model, and
  what it says — a constraint's name, a statement — is not for it. Every handler logs the
  cause and answers `isError` with a sentence of this module's own.
- **`upsert_task`'s status is optional although the task has one**: left out, an existing
  task keeps the status it reached. Required, a model restating a finished task would have
  to pick one, and would reopen it.
- **The SDK is loaded by `ClaudeAgentToolkitLoader`, inside `createServer`**, for the reason
  nothing imports it at the top of a file (_Claude_, above). So the unit specs' fixture
  (`meeting-tools.fixture.ts`) and `test/meeting-tools.e2e-spec.ts` both stand a
  two-function fake in its place — the e2e
  spec with everything behind a tool real — and **the SDK's own `tool` and
  `createSdkMcpServer` run only in `test:live`**, where the real model calls the real
  server over a `TaskService` held in memory.

**Over stdio — `stdio/` and `src/meeting-tools-stdio.main.ts`**

The meeting's tasks as an MCP server of its own, for a client that is not this process: built
with `@modelcontextprotocol/sdk` — `McpServer`, each tool registered with `registerTool`
over its Zod shape, the stdio transport — and started by its client as a subprocess,
`node dist/meeting-tools-stdio.main.js <meeting-id>`, with its user's access token in
`MEETING_TOOLS_ACCESS_TOKEN`. It serves two tools, `find_tasks` and `upsert_task`; two
resources, the open tasks and one task by its id; and two prompts for gathering what is
known about the meeting. It is a task manager for one meeting: everything that reads or
writes is `TaskService`'s, and nothing of the meeting itself — its title, its files, its
digest — is served.

- **`find_tasks` is the in-process server's tool, not a second one like it.** Its name,
  description, shape, and behaviour are `FIND_TASKS_TOOL` and `findTasksOf`
  (`find-tasks.tool.ts`), which `MeetingTools` hands a digest's run as well; what differs is
  only which SDK serves it.
- **`upsert_task` is the same service under a shape of this server's own**
  (`upsert-task.tool.ts`): a title and an optional status, and **no meeting among its
  arguments**. A digest's run is given the meeting's id and passes it back, checked; a
  client of this server was never given one, and the meeting it writes to is the process's.
  What the two shapes share is `taskTitleInput` and `taskStatusInput`, so they cannot come
  to disagree about what a title or a status is, and both end in `TaskService.upsert` —
  nothing here touches the database itself. It carries `readOnlyHint: false`, said rather
  than left to the default, beside `find_tasks`'s `true`: a client that decides what to ask
  its user about reads them.
- **The resources are `tasks://open` and `task://{taskId}`**
  (`stdio/meeting-tools-stdio.resources.ts`), both `application/json`: `TaskService.open`
  for the server's meeting at a fixed address, and `TaskService.get` behind a
  `ResourceTemplate` whose `list` is `undefined` — said on purpose: a task is found by
  search and then read by its id, and the template lists nothing. **A task is answered
  only when it came out of the server's meeting.** The id is its reader's to choose, so
  without that check an id from anywhere reads a task of a meeting its reader cannot see;
  an id that is not a UUID, one no task has, and another meeting's task are one error, as
  they are one 404 on a route. The resolver is handed the `requester` — the user the token
  names — and decides nothing by it yet: a task has no assignee, so whoever may read the
  meeting may read each of its tasks. It is there for the rule that will.
- **A resource that cannot be read is an error of that file's own wording**, as a tool's
  is: the SDK hands a thrown error's message to the client as it is, so a refusal, a
  missing task, and a failed read are each an `McpError` made here, and the cause is the
  log's.
- **The prompts are `meeting_overview` and `meeting_topic`**
  (`stdio/meeting-tools-stdio.prompts.ts`): instructions for the client's model to collect
  what the meeting's tasks say, as a whole or about one topic, from this server's own
  resources and tools. Each ends by telling the model to change nothing and to read task
  titles as data, since the server cannot make a client do either. **A prompt is text and
  carries no data** — no task, not the meeting's id — which is why the prompts alone are
  not behind the access check. One that quoted a task would have to be.
- **`update_meeting` is not there on purpose.** This server keeps tasks; rewriting a
  meeting's summary and decisions from outside the API is a decision nobody has made.
- **A process is started for one meeting, named on its command line, and reaches no other**
  — the in-process server's rule, for its reason: the meeting is not an argument of either
  tool, so nothing a model sends can widen a search or aim a write. An id that is missing or
  is not a UUID is a usage line on stderr and exit code 1, before anything connects to the
  database. The id is lower-cased as it is read: Postgres compares UUIDs whatever their
  case, but a task is matched to the server's meeting as text.
- **It answers for one user, and checks them before every call and every read.** The client hands it the
  access token `POST /api/auth/login` answers with; `MeetingToolsStdioAccess` has `auth`
  verify it (`AccessTokenVerifier`, as the guard does) and asks `meetings` whether that user
  can see the meeting (`FindVisibleMeetingQuery`, so `visibleTo`: the host and the
  participants, who are who the meeting, its files, and its digest are shown to). The same
  rule lets them write a task — a participant already uploads to a meeting. **Asked twice,
  on purpose**: once before anything is served, so a stale token or a wrong meeting is a
  line on stderr and exit code 1 instead of a server whose every call fails; and again
  before every call, as a route checks every request, because a process outlives a token
  and a session must not. A user taken off the meeting, a meeting deleted, a token past
  `JWT_EXPIRES_IN_SECONDS` — each closes the tools and the resources at the next request,
  with an error that says which, and the client restarts it with a new token.
- **No lookup of the user, unlike the guard.** The guard makes one so a token cannot outlive
  its account; here the meeting's own row does that — a user who is gone hosts and attends
  nothing. A meeting that does not exist and one the user is not in are one sentence, as
  they are one 404 on a route.
- **A check that fails is a refusal, never a way in.** `MeetingToolsStdioServer.admit` is
  the one gate, answering who is asking or the sentence they are refused with — the
  latter also when the check itself throws, the database gone. Every tool and both
  resources ask it first, and their own work is a function not yet called. **Each is let in
  by an answer that names a requester, never by one that merely carries no refusal.** Whatever is
  added to this server that reads or writes goes through it; registered without it, it is
  open to whoever holds any token at all.
- **The token arrives in the environment the process is started with — never on the command
  line**, which every process on the host can read with `ps`, **and never from an env
  file**. It is never logged and never repeated in a refusal. `ConfigModule` reads the env
  files for the database and the key, so `validateMeetingToolsStdio` takes the token from
  `process.env` alone, which at that moment still holds only what the process was started
  with: `ConfigModule` copies what it read from a file there after `validate` returns. Read
  from a file as well, a server started with no token would not refuse — it would answer
  as whoever left one there.
- **stdout belongs to the protocol, and that is why nothing starts it through `pnpm`.**
  Every frame is a line of JSON there, so one stray line ends the session: the process's
  logger is `StderrLogger` (`src/common/logging`) because Nest's own writes everything but
  errors to stdout, and there is no package script because `pnpm run` echoes the command it
  runs on stdout before the server has said a word. Anything added to that process logs
  through the logger, and nothing in it may write to `process.stdout`.
- **It is not `AppModule`, and its environment is held to a contract of its own.**
  `MeetingToolsStdioModule` is the config files, the database, `TasksModule`, and the two
  narrow modules that decide who may ask — `AccessTokenModule` and `MeetingQueriesModule` —
  no HTTP, no worker, no Claude: importing `AuthModule`, `MeetingsModule`, or
  `MeetingToolsModule` instead would bring the credential routes, the rate limit, the
  toolkit loader, and the command bus into a process that keeps tasks. It reads `.env.local`
  and `.env` **from its working directory**, so a client starts it in `apps/api` or hands it
  the variables itself. The contract is `env.validation.meeting-tools-stdio.ts`:
  `DATABASE_URL`, `JWT_SECRET`, and the token, and a process it refuses does not boot —
  after the usage line for a missing meeting, before anything connects to the database. The API's own would refuse over an upload directory or a CORS origin this
  process never touches. **`JWT_SECRET` is held to the API's rule there** (`IsJwtSecret`, in
  `env-contract.ts`, the one statement of it): a verifier started on the published
  placeholder takes a token anybody who has read this repository can mint, for any user.
- **The check is not a defence against whoever starts it.** That operator holds
  `DATABASE_URL` and the signing key, and so every meeting and every identity already. What
  the token decides is whose meetings a correctly installed server will serve — the user's
  own, not whichever id ended up in a client's configuration. Put behind a transport that
  takes connections, the same check is what would stand between `TaskService` and anybody:
  it is `visibleTo`, as that module's guide asks.
- **It ends when its client does, and the transport does not see to that.** The SDK's stdio
  transport listens for data on stdin and not for its end, so a client that closed the pipe
  left a process holding a database connection for good. The entry point closes the server
  and then the application when stdin ends, or on either signal — and exits because nothing
  is left listening, not because it was told to. **The server's own close is a fourth way
  in, and it is why closing is a flag set first**: a frame too large to be one makes the
  transport close itself and stop reading stdin, after which the pipe's end is never seen;
  and `server.close()` reports the close it has just made to that same callback before it
  returns, so anything less than a flag closes the application twice.
- **What a tool answers with is what people said in a meeting, and its reader may hold
  more than the digest's model does.** A task's title is text a run's model took from a
  transcript — or, now, text a member's own client wrote through `upsert_task` — stored as
  given, and read back by the next digest's run through `find_tasks` like any other. In this process's twin that text is read by a Claude with no
  tool that touches its host; over stdio it is read by whatever client the operator
  configured, which may hold a shell. The answer is data — the README says so to whoever
  wires the server up — and nothing here can make a client treat it as that.
- **This SDK is imported at the top of a file, and the Claude Agent SDK still is not.**
  `@modelcontextprotocol/sdk` ships a CommonJS build beside its ESM one, which Node, Nest's
  build, and Jest all load directly. It is a direct dependency, though the Agent SDK already
  brought it in, because pnpm's strict layout lets a package import only what it declares —
  and it is pinned to the version the Agent SDK resolves, so the two share one copy and one
  `CallToolResult`. Bump them together.
- **Unit specs and two e2e specs, for different things.** The three specs in `stdio/` —
  the server's tools, its resources, its prompts — join a real MCP client to the real
  `McpServer` in memory (`meeting-tools-stdio.fixture.ts`), over a faked `TaskService` and
  a faked access check: what is listed, what a call or a read does, what is refused, and
  that the check comes first every time. The other two start the entry point as a subprocess —
  through `ts-node`, so no build has to exist — with a real MCP client on the other end of
  the pipe (`test/utils/meeting-tools-stdio.ts`). `test/meeting-tools-stdio.e2e-spec.ts` is
  the only place that can show stdout carrying nothing but frames, the meeting on the
  command line being the one searched, and the process ending by itself when the pipe
  closes. `test/mcp-server.e2e-spec.ts` is the server as its client meets it: the tools,
  the resources, and the prompts against a real database, and who is answered at all — the
  host and a participant with the tokens the API issued them, and not a stranger, a forged
  or expired token, no token, or a participant removed while it is up. **Both hand the subprocess
  `JWT_SECRET` and the token explicitly**: the environment wins over the env files, so it
  verifies with the key the suite's API signs with, not the one in a developer's `.env`.

**The hooks — `meeting-hooks.ts`**

`MeetingHooks.createHooks(maxToolCalls)` answers with what `query()` takes as
`options.hooks`: callbacks of the SDK's `HookCallback` type, which Claude Code calls in this
process before and after a tool call.

- **`preToolUseGuard`**, on `PreToolUse` for `mcp__meeting__upsert_task`: a title that is
  blank or under `MIN_TASK_TITLE_LENGTH` (3) characters is denied, with a reason that says
  what a title needs. It reads the arguments as the model sent them — before the tool's
  shape has trimmed or checked anything — so
  it expects a title that is missing or not text. **The bound itself is the tool's**:
  `MIN_TASK_TITLE_LENGTH` is in the tasks' constants and in `upsert_task`'s shape, so a
  server handed to a run without these hooks refuses the same titles. The hook says it
  sooner, and in words the model can act on.
- **`callBudget`**, on `PreToolUse` for every meeting tool: counts the calls of one run and
  denies each one past the limit, telling the model to answer. A call counts when it is
  asked for, so one the guard refuses has been spent. **It is made per run, and it never
  counts the SDK's `StructuredOutput`**: refused that, a run out of calls could not do the
  one thing it is told to.
- **`auditLog`**, on `PostToolUse` and `PostToolUseFailure` for every meeting tool: one
  `log`-level line with the tool's name, its arguments, and its result or error. **This puts
  meeting content in the API's log** — a task's title, a summary, decisions — where until
  now there were ids, durations, and costs. Each of the two is JSON on one line, so a line
  break in a title cannot start a line of its own, and is cut at `MAX_AUDITED_CHARACTERS`.
  A call a hook denied reaches neither event; the hook that denied it logs a warning.
- **Every hook checks the tool's name itself**, and answers `{}` — no decision — for
  anything else. The matcher only decides whether the SDK asks: Claude Code reads one made
  of letters, digits, and underscores as a tool's whole name and anything else as a regular
  expression, so the one for every meeting tool is `^mcp__meeting__`, anchored here rather
  than left to how the expression is applied. `test:live` ran the budget and the log under
  that matcher; the guard's, a whole name, has run only in the unit spec.
- **No hook answers `allow`.** Whether a call may run stays `allowedTools`' to say; a hook
  here only ever takes a call away.
- **A refusal is not which meeting a run may touch.** That is the handlers' rule above, and
  it holds with no hook registered.

## Bootstrap behaviour (`src/configure-app.ts`)

**Every global belongs in `configureApp`, not in `main.ts`.** `main.ts` and the e2e test app
both call it, so a global added in one place cannot go missing from the other — the e2e specs
assert behaviour that only exists because of these, and would keep passing against a test app
that had quietly diverged. Only process-level concerns (`enableShutdownHooks`, `listen`) stay
in `main.ts`.

- **`ConnectionDrainService`'s middleware, first in the chain**, and its provider in the root
  module. Until shutdown it only counts; from the first shutdown hook on it makes every
  connection carry its last answer: `Connection: close` on any response not yet started, and
  the socket closed behind one already under way. **Node does not do this.** `server.close()`
  closes idle connections once, when it is called; a connection busy at that moment — a files
  stream is, on every open meeting page — is kept alive again afterwards, and a page that
  reopens its stream after a second and polls every three never gives it the five idle
  seconds that would close it. A stopped API answered one open page for 96 seconds, workers
  gone and Prisma disconnected. **Not `forceCloseConnections`**, which destroys every socket
  and an upload in flight with it. The spec beside the class pins the Node behaviour too, in a
  case with no drain, so the day Node closes those connections itself that case fails and the
  class can go.
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
- **`HttpExceptionFilter`** from `src/common/`.
- **The request log is middleware (`createRequestLogger`), after CORS and before anything
  that can refuse a request — and it must not become an interceptor again.** An interceptor
  sees only what reached a handler, once per value the handler answers with: a request a
  guard refused (a bad token, a spent rate limit) and a path no route matches left no line
  at all, so a run of failed sign-ins was invisible, while a files stream left a line for
  every event and heartbeat it sent. Here a request is one line, written when its response
  closes: a refusal is a warning, and a connection the client closed first says so in place
  of a status it never got. After CORS, because CORS answers a preflight itself and a line
  per preflight would double the log. **The request target is written as visible ASCII and
  cut to a line's length**: whoever sends the request chooses it, and the line is now written
  for callers no guard has let in. `request-log.e2e-spec.ts` pins the guard's 401, the
  unknown route, and the stream's single line.
- **An error is logged through `describeError` (`src/common/error-message.ts`), never as
  `error.stack`.** A stack stops at the wrapper, and the wrapper is a sentence this code
  chose: every `{ cause }` attached to keep an `ENOENT`, a constraint, or the SDK's own
  failure was being dropped at the one place it was kept for. `describeError` puts each
  cause's stack under the error that wraps it.
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

**The transcription variables are in all three, and their values differ on purpose.**
`apps/api/.env.example` ships the URL of the `whisper` service as the host reaches it
(`localhost:8000`) with the flag still `false`, so turning transcription on locally is one
edit. `docker-compose.yml` hands the `api` service the same variables with the URL defaulting
to the in-network name (`whisper:8000`), and takes the flag from the root `.env`. The default
time limit is stated once for code, in `src/config/transcription.defaults.ts`, and restated
in those two files because neither can import — change all three together. The model has no
default in code at all: those two files are the only places the local one is named.

**The digest's three variables are in the first two and not the third.**
`MEETING_DIGEST_ENABLED`, `MEETING_DIGEST_TIMEOUT_SECONDS`, and
`MEETING_DIGEST_MAX_TOOL_CALLS` are in the contract and `apps/api/.env.example`, with
`ANTHROPIC_AUTH_TOKEN` required whenever the flag is on. `docker-compose.yml` hands its `api`
service none of the three, so the digest is off there whatever the root `.env` says: nobody
has yet checked that the image, which is Alpine, carries a Claude Code binary the SDK can
start. Adding them to Compose goes with that check. The time limit's default and the call
budget's are stated once for code, in `src/config/meeting-digest.defaults.ts`, with their
measurements. **The generator reads the budget with `ConfigService.get` and adds to it**, so
it has to be a number: the contract makes it one, and a module built without the contract —
`test:live`'s — sets it as a number itself, since `ConfigService.set` writes text to
`process.env` and a value set to `undefined` reads back as that word.

**The contract is two classes, and `validate` checks them as one.** The transcription
settings are `TranscriptionEnvironmentVariables` in `env.validation.transcription.ts`, which
`EnvironmentVariables` extends — class-validator and class-transformer both inherit a
parent's decorators. That is a file-size split, not a second contract: a new variable goes
where its feature's are, and a third feature's would extend the chain.

**There is a second contract, for a second process.** The meeting tools' stdio server is
not `AppModule` and validates `env.validation.meeting-tools-stdio.ts` instead: three
variables, of which `MEETING_TOOLS_ACCESS_TOKEN` is read by nothing else, is deliberately
absent from the API's contract and from the value lines of `.env.example`, and is the one
variable in this package that an env file cannot set — it is its client's to hand over,
per user. What the two contracts share is `env-contract.ts`:
`checkedAgainst`, which validates and words the error, and `IsJwtSecret`.

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

- **The API never applies migrations at boot**, and each way of starting it has its own
  `prisma migrate deploy`: `pnpm start:dev` for development, the e2e suite's global setup for
  its own database, and under Compose the one-shot `migrate` service, which `api` waits on
  with `service_completed_successfully`. A service of its own rather than a step in the
  image's command, so it runs once however many `api` containers start and a failed migration
  stops the stack before an API boots on a schema it does not match. An image started any
  other way needs it run first — `node_modules/.bin/prisma migrate deploy` in
  `/repo/apps/api`.
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

**`pnpm test` does not run `test:e2e`** (it is not in `turbo.json`, because it needs
Postgres), **and so neither does the pre-commit hook: a module whose only coverage is an e2e
spec is uncovered until CI, whose `api-e2e` job is the one thing that runs the suite
unasked.** Every command handler, query handler, and read service gets a `*.spec.ts` beside
it for that reason, not for a coverage number.

**A spec that needs a whole stored row builds it from a `*.fixture.ts` beside the code** and
names only the columns its case is about — `buildMeetingFileRecord` is the one that exists —
so a column added to the table is one edit there, not one in every spec. `tsconfig.build.json`
excludes the pattern as it does specs, so a fixture never reaches `dist`.

**`test:live` is a third suite, and the only one that leaves the machine.** `test/*.live-spec.ts`
under `test/jest-live.json` sends real requests to Anthropic — nothing mocked, nothing replayed
— so it needs the network and a working `ANTHROPIC_AUTH_TOKEN`, and costs a few cents a run. It needs no database — the tasks a run's tools keep are `LiveMeetingTasks`, in memory — which is why it is not an e2e spec, and nothing runs it but you.
`claude-agent.live-spec.ts` is the SDK itself; `meeting-digest.live-spec.ts` is the digest's
instructions held to the PRD by the real model, over the reference transcripts in
`test/fixtures/meeting-digest` (`test/utils/meeting-digest-fixtures.ts` says what each is, and
how the recording of the script beside them was made); `meeting-digest-budget.live-spec.ts`
is the budget of tool calls, in both halves — the model planning for the number it is told,
and the hooks holding it to a number it was not; `meeting-digest-measure.live-spec.ts`
is the digest's measurements, every one of them skipped unless its variable asks for it.

- **The token comes from the env files, not the shell.** The spec builds a `ConfigModule` over
  `ENV_FILE_PATHS`, the files `AppModule` reads, relative to `apps/api`. They are gitignored,
  so **a fresh worktree has none**, and the suite fails with `ANTHROPIC_AUTH_TOKEN is not set`
  until one exists there. The spec deletes the variable from `process.env` before loading
  them, and that is the one place it departs from the API on purpose: `ConfigModule` lets the
  environment win, so a token exported in a developer's shell would otherwise be the one a
  run spends — or the reason it fails with a good token in the file.
- **The script sets `NODE_OPTIONS=--experimental-vm-modules`**, which is what lets Jest load
  the ESM-only SDK. A spec in any other suite that sends a prompt fails on that import.
- **The refused-token test is what makes the other one evidence.** It swaps in a token
  Anthropic never issued and expects `AUTHENTICATION`; were the SDK using a credential it
  found elsewhere on the host, that call would succeed too.
- **A digest spec asserts what a digest holds, never how it is worded.** The model words the
  same meeting differently on every run, so the reference is checked for two action items, an
  owner, and a decision by pattern — and a wording assertion would be a flaky one.

A mocked SDK would only repeat back what the mock assumed, so the unit specs cover what is
decided on this side of it: no token, no call; a call already called off starts nothing; and
`outcomeOf`'s table of what each result the SDK is known to produce becomes.

E2E specs run against a real database, **and never the one `DATABASE_URL` names**: the suite
uses that database's name with `_test` after it, on the same server (`testDatabaseUrl`, in
`test/utils/test-database.ts`). `test/utils/create-test-app.ts` boots `AppModule` and
`useApiSuite` empties `users`, and everything that hangs off it, before every test — against
the configured database that was a developer's own data gone at the first run. So
`test:e2e` needs `docker compose up -d postgres` and nothing else: `test/global-setup.ts`
creates the database when it is missing and runs `prisma migrate deploy` on it before the
first spec. Three things about it:

- **A name that already ends in `_test` is used as it is.** That is what makes the answer
  safe to feed back in — `setup-env.ts` writes it to `DATABASE_URL` once per spec file — and
  it is how to choose a database on purpose: a second session on the same Postgres runs
  with `DATABASE_URL=…/video_meetings_<name>` and gets `video_meetings_<name>_test`.
  **Except one that ends in the browser suite's `_web_test`**, which ends in `_test` as well:
  used as it is, both suites would be handed one database. It gets this suite's suffix like
  any other name, and `truncateUsers` refuses such a database outright.
- **`truncateUsers` refuses any other database, in the statement that would empty it.** The
  environment is what points the suite at a test database; the refusal is what holds if that
  line is ever lost. `test-database.e2e-spec.ts` pins both.
- **The web app's Playwright suite has a database of its own by the same rule, with
  `_web_test` for the suffix** (`browserSuiteDatabaseUrl`), so the two suites never empty
  each other's. `test/e2e-web/environment.ts` points that suite's API at it and
  `test/e2e-web/main.ts` creates and migrates it before the module is compiled — there and
  not in Playwright's `globalSetup`, which runs after the servers have started. Its teardown
  is in the web package and restates the rule, with the same refusal.

Cleanup runs at both ends for different reasons: `beforeEach` so no test inherits another's
rows (which is also what makes a repeated run independent of the last), `afterAll` so the
final test's fixtures are not stranded.

Nine things about that setup are easy to get wrong:

- **Environment must be set in `test/setup-env.ts`, not in a helper.** `ConfigModule.forRoot()`
  is evaluated when `app.module.ts` is _imported_ and prefers `process.env`, so anything
  assigned after that import — including at the top of `createTestApp` — is too late, and the
  app signs tokens with the developer's local `JWT_SECRET` while the specs verify with the test
  one. The failure looks like broken signing code, not configuration. Jest `setupFiles` runs
  early enough. The same file points `MEETING_FILES_DIR` at a per-run temp directory and sets
  `MEETING_FILES_WORKER_ENABLED=false`. **It also sets `MEETING_DIGEST_ENABLED=false`**,
  which looks redundant beside a default of off and is not: the env files are still read,
  so a developer's `.env` with the digest on would otherwise switch it on for every spec —
  the real `ClaudeAgentService` wherever the fake is not bound — and a run with
  `ANTHROPIC_AUTH_TOKEN` exported empty would not boot.
- **`start:e2e-web` must stay in step with it**: the same temp-dir idea, but the worker **on**
  with a fast poll, because the web app's browser suite watches the Processing chip disappear —
  and the same out-of-reach auth rate limit, because that suite registers through the UI in
  every spec and would meet a deployment's ten a minute part-way through a run. It also
  switches transcription **on** and names `127.0.0.1:3102`, where that suite starts a fake of
  its own (`apps/web/e2e/fake-transcriber.mjs`); here the setting stays off except under
  `useTranscriptionSuite`.
- **`start:e2e-web` does not run `src/main.ts`: it runs `test/e2e-web/main.ts` through
  `ts-node`**, and that file is the browser suite's Claude. The Claude Agent SDK has no HTTP
  seam to stand a fake behind, as Whisper has `TRANSCRIPTION_API_URL`, so the stand-in has
  to be inside the process — and production code is given no way to ask for one. The entry
  point is `main.ts` again with one provider overridden: the same `AppModule`, the same
  `configureApp`, the same workers, and `ScriptedClaudeAgent` bound over `ClaudeAgentService`.
  **The setting, the token, and the fake are switched together, in `test/e2e-web/environment.ts`,
  and must stay together**: it sets `MEETING_DIGEST_ENABLED=true` and a placeholder
  `ANTHROPIC_AUTH_TOKEN` (the boot check wants one, and the suite is run with the variable
  exported empty) before `AppModule` is imported. Move the setting into the script and the
  day someone points that script back at `nest start`, every recording the browser specs
  transcribe is a paid request to Anthropic. What the scripted Claude does is decided by
  directives in the transcripts it is sent — the table is in `digest-script.ts` — and a
  generation is held, or failed, only while a spec holds the key its transcript names, on a
  loopback-only control port (3103) that is a listener of the entry point's own, not a route
  of the application. **That port also switches `MEETING_DIGEST_ENABLED` in the running
  process** (`ConfigService.set`, as `configureDigest` does for the specs here), because a
  recording "transcribed while the setting was off" is the state the boot's catch-up exists
  for and a spec cannot restart the API. That stays inside the rule above: what the setting
  gates in this process is the scripted Claude, whichever way it is switched. **And it runs
  the catch-up, as a request of its own** (`POST /control/catch-up`): in a deployment the
  setting comes back with a boot and the boot catches up, but here `claude.reset()` switches
  it on around every test over a database the specs share, and a catch-up tied to the switch
  would generate, before each test, for whatever every earlier one left owed. Nothing under
  `test/e2e-web` is covered by `pnpm typecheck`; `ts-node`
  type-checks it at every boot, so a changed `src` signature it uses stops the browser suite
  from starting rather than failing a spec.
- **`maxWorkers: 1` is load-bearing**, for the same reason: Jest parallelises across spec
  files, and in parallel they delete each other's fixtures and a seeded `register` starts
  returning 409. Remove it only alongside per-worker database isolation.
- **`test/utils/` reads the database over raw SQL**, not through `prisma.user`, so the specs pin
  table and column names directly. A response is not evidence about what was written: asserting
  through the API would reuse the same `include` the implementation does, so a row the code
  never meant to write — the host landing in `meeting_participants` — would be invisible.
  `truncateUsers` cascades to `meetings`, `meeting_files`, `meeting_file_uploads`, and the
  four `meeting_digest*` tables, which is why the file and digest specs need no cleanup of
  their own and why there is deliberately no second
  truncation helper to disagree with it about what "clean" means. The files' helpers also seed
  states a route cannot produce on demand (`leased_until`, `attempts`, `purged_at`, a past
  `expires_at`, a transcription claim whose worker died).
- **`test/utils/sse.ts` is the only client that can read a stream route**, over Node's `http`
  directly. Supertest buffers a whole response and resolves when the server ends it, which for
  `files/events` is after the TTL — ordering could not be asserted and every test would cost the
  TTL. The helper parses events as they arrive and hands them over one at a time; a non-200 is
  read to completion and exposed as `body`.
- **`test/utils/fake-transcriber.ts` is the Whisper the transcription specs talk to** — an
  OpenAI-shaped endpoint on loopback that a spec tells to answer, fail, or hold — rather than a
  fake bound to `TRANSCRIPTION_PROVIDER`. The application's own HTTP adapter is therefore what
  runs: an error body really crosses the wire before a spec asserts it reached no row, and a
  request the worker aborts really is hung up on (`hangUps`). `useTranscriptionSuite` starts
  it, points the application at it, and switches the setting on before each test; every other
  spec file runs with transcription off, which is why none of them had to change.
- **`test/utils/fake-claude-agent.ts` is the Claude the digest specs talk to**, bound over
  `ClaudeAgentService` itself through `useApiSuite({ overrides: [claude.override()] })` — not
  over the SDK loader, and not over the generator. So the prompt builder, the answer's guard,
  and the worker all run for real, `calls` holds the exact text that would have left for
  Anthropic, and no spec needs a token or the network. Its default answer is `digestOf` the
  prompt — one decision per recording, quoting its transcript — which is what lets a spec
  assert "the digest covers all three" without a model's wording. `useDigestSuite` resets it
  and switches the setting on before each test; its `transcribe` takes a recording all the
  way to Transcribed through the fake Whisper, and returns once the request that made has
  been written — as `remove` deletes a file and returns once the digest has followed it,
  both by waiting on `PendingDigestRequests`. `watch` opens the meeting's files stream and
  hands over its `digest` events one at a time, each held to a version above the last — so
  every spec that reads the stream is also a spec of the rule a page relies on. `ask` is
  Retry, returned unawaited because most of what a spec says about that route is which
  status it answers. `catchUp` is the boot's catch-up, run by hand: the suite's application
  boots with the digest off and so never runs it by itself, and the one spec that boots a
  second application with it on is `meeting-digest-catch-up-boot`. Every other spec file
  runs with the digest off.
- **An environment the contract refuses does not throw when `AppModule` is imported.**
  `ConfigModule.forRoot` is `async`, so the refusal is a rejected promise inside the module's
  `imports` that nothing awaits until Nest compiles it — and an `expect(import(…))` passes
  while the rejection surfaces in whichever test runs next. `meeting-digest-setting`'s boot
  cases therefore compile the module, in `jest.isolateModulesAsync`, with `@nestjs/testing`
  imported inside the isolate too so the two agree on what a module is.
- **`test/utils/jwt.ts` verifies tokens with `node:crypto` alone**, never the library the API
  signs with, so a token only `@nestjs/jwt` can read fails the assertion. It is checked against
  a signature produced by `openssl dgst -sha256 -hmac`. Do not "simplify" it into `JwtService`.

## Keeping this guide current

Update it in the same commit as the change;
[the root guide](../../AGENTS.md#keeping-documentation-current) covers the general rules, this
one owns what is specific to `@repo/api`. The sections above each name what would invalidate
them — a global added to `configure-app.ts`, a Prisma upgrade that moves the constraint `meta`
shape, a fourth message on the auth/user boundary, a new exemplar module replacing one of the
five, a third event or the first saga, a change to the
`apps/api/**` lint overrides. Adding a feature
module that follows the existing shape needs no update: document the shape, not each module
that uses it.
