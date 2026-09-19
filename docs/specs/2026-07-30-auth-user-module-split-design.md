# Splitting `auth` into `auth` and `user`

**Date:** 2026-07-30
**Status:** implemented
**Supersedes:** the auth-module portion of
[`2026-07-29-video-meetings-monorepo-design.md`](2026-07-29-video-meetings-monorepo-design.md)

## Problem

`src/modules/auth` had grown to own two unrelated things: authenticating a caller, and the
user record itself. `RegisterHandler` wrote to `prisma.user`, `LoginHandler` read from it,
`JwtAuthGuard` read from it again, and `toPublicUser` sat in a file named for the request type
that happened to need it. Nothing about the arrangement said where a second consumer of users
should look, and any module wanting a user would have had to import the authentication module
to get one.

## Decision

Two modules, talking only over the CQRS buses.

`AuthModule` owns credentials, argon2 hashing, token issue, and the guard. It reaches no
database: `PrismaService` appears nowhere under `src/modules/auth`.

`UserModule` owns the user record — the insert, the lookups, the public shape, and the
display-name rule. It has no controller, no routes, and no exports.

### The interface

| Message                           | Carries                 | Resolves to               |
| --------------------------------- | ----------------------- | ------------------------- |
| `CreateUserCommand`               | `email`, `passwordHash` | `User`                    |
| `FindUserByIdQuery`               | `userId`                | `User \| null`            |
| `FindUserCredentialsByEmailQuery` | `email`                 | `UserCredentials \| null` |

`RegisterHandler` hashes and dispatches the command. `LoginHandler` dispatches the credentials
query. `JwtAuthGuard` dispatches the by-id query. Nothing else crosses.

## Why the buses rather than an exported service

`CqrsModule`'s `ExplorerService` scans every module in the Nest container and registers all
handlers into one set of buses, so naming a command or query class reaches its handler wherever
it lives. `AuthModule` therefore does **not** import `UserModule` — the decoupling is real
rather than stylistic, and there is no provider either module could inject across the boundary
even by accident.

The alternative considered was `UserModule` exporting a `UsersService` for auth to inject, with
only the write going through the `CommandBus`. It is less machinery, and it matches what
`MeetingsService` already does for reads. It was rejected because it makes the boundary a
compile-time dependency: auth would import the user module, and the next person needing a user
would reasonably inject the same service from a third module, at which point the interface is
"whatever is public on that class" rather than three named messages.

## Why the `QueryBus` is justified here specifically

The API guide previously stated that no `QueryBus` existed and that adding one for symmetry
with the write side was ceremony. That reasoning still holds and has been kept: `MeetingsService`
serves two reads from a plain service and should continue to.

What changed is that a read now **crosses a module boundary**. The test for reaching for a
query is whether the read leaves the module, not whether it sits next to a write.

`GET /me` still reaches no handler of its own. The guard dispatches `FindUserByIdQuery` while
authenticating and `@CurrentUser` returns what it attached, so an authenticated request costs
one user lookup, in the guard, where the lookup already was.

## Where the password lives

`PasswordService` stays in auth, and `CreateUserCommand` carries a hash rather than a password.
Hashing policy and the account-enumeration defence are authentication concerns; the user module
could not distinguish a good hash from a bad one and should not be handed the chance to try.

This keeps auth's two security invariants in the file that owns the use case:

- `LoginHandler` still throws one `INVALID_CREDENTIALS` message for both the unknown-email and
  wrong-password paths.
- The no-account path still `await`s `PasswordService.verifyDummy`, so a miss costs what a hit
  costs. **No test catches its removal** — this was true before the split and remains true.

The rejected alternative was moving `PasswordService` into the user module and having auth
dispatch a `VerifyUserCredentialsQuery` returning a user or `null`. It keeps every password byte
in one module, but it moves both invariants above out of auth, and a query that verifies a
secret is a write-shaped read.

## Two rules no type enforces

- **No raw password crosses the boundary.** Only a hash does.
- **`UserCredentials` is declared in its query file, never in `@repo/shared`.** That package is
  imported by the browser bundle; a password hash must not appear in a type the client can name.
  This is also why it is a separate query rather than a flag on `FindUserByIdQuery`: only the
  login path asks for a secret, and every other caller gets a shape that cannot leak one. Both
  user-returning paths map through `toPublicUser`, making the omission of `passwordHash` a
  property of the module rather than of each call site.

## Consequences

- The 409 for a taken address moves to `CreateUserHandler`, which owns the insert and is the
  only place that can answer authoritatively. `RegisterHandler` does not catch it on the way
  past.
- Query handlers return `null` for "no such row" rather than throwing `NotFoundException`, so
  the caller decides what a miss means — the guard answers 401 today.
- `displayNameFromEmail` moves to `user/services/user.mapper.ts`; `normaliseEmail` stays in
  auth as a DTO transform.
- The HTTP contract does not change. All 109 e2e assertions passed unmodified at every step of
  the refactor, which is what made the split verifiable rather than merely plausible.

## Not done

`@nestjs/cqrs` 11 ships `Query<TResult>` and `Command<TResult>` base classes that carry the
result type and would remove the explicit type arguments at each dispatch. The messages here
are plain classes, consistent with the three that predate them. Adopting the typed base classes
is a reasonable follow-up, but as one commit converting all of them — not a second convention
alongside the first.

No `EventBus`, events, or sagas. A `UserRegisteredEvent` with no subscriber would buy a file to
read and nothing else.
