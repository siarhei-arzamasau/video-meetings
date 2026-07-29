# Auth Module — CQRS Refactor

**Date:** 2026-07-30
**Status:** Approved
**Scope:** `apps/api/src/modules/auth` only. No change to the HTTP contract, the database schema, or `apps/web`.

## Goal

Restructure the auth module so each write operation is a command object with a dedicated
handler, dispatched through `@nestjs/cqrs`'s `CommandBus`. Nothing observable changes: the
three routes keep their paths, status codes, response bodies, and error messages. The
existing e2e specs are the proof of that and must pass unmodified.

### Why, honestly

With two write operations and no real read handlers, CQRS solves no problem the module has
today. It is being adopted for the shape it gives later work — one class per use case, a
uniform place for new operations to land, and an `EventBus` already wired when a second
consumer of "a user registered" appears. This document records that as a deliberate
structural bet, not as a fix for a present defect.

## Starting point

| File                        | Role today                                                           |
| --------------------------- | -------------------------------------------------------------------- |
| `auth.controller.ts`        | Three routes, injects `AuthService`                                  |
| `auth.service.ts`           | `register`, `login`, `issueToken`, the `dummyHash` timing defence    |
| `jwt-auth.guard.ts`         | Verifies the bearer token and reads the user through `PrismaService` |
| `current-user.decorator.ts` | Returns the guard-attached user; throws if the guard did not run     |
| `dto/`, `email.ts`          | Request DTOs and email normalisation/display-name helpers            |

`AuthService` is referenced in exactly three places (its own file, the controller, the
module) and has no unit spec. `GET /me` never reaches a service — the guard loads the user
and `@CurrentUser` returns it.

## Decisions

### Build on `@nestjs/cqrs`

Add `@nestjs/cqrs@11.0.3` as a dependency of `@repo/api`. Its peer ranges
(`@nestjs/common` and `@nestjs/core` `^11`, `rxjs ^7.2`, `reflect-metadata ^0.2`) are all
satisfied by the current pins. It is pure JavaScript with no install script, so it needs no
`allowBuilds` entry in `pnpm-workspace.yaml` — confirm at install time rather than assuming.

The alternative considered was hand-rolled handler classes injected directly, with no bus.
That avoids a dependency and keeps stack traces flat, but it produces something that only
resembles CQRS; the package is what a reader will expect the word to mean.

### `CqrsModule` is imported by `AuthModule`, not registered globally

No other module in the app uses commands. A global registration would advertise a house
style that does not exist and make every future module look like it opted in.

### Commands only — the guard and `GET /me` are untouched

`JwtAuthGuard` keeps its direct `PrismaService` read, and `GET /me` keeps returning the
user the guard attached. Two alternatives were rejected:

- Dispatching the guard's read through a `QueryBus` puts bus indirection on the hot path of
  every authenticated request and makes guard failures harder to trace.
- Turning `GET /me` into a query gives the `QueryBus` real work, but costs a second database
  read per request unless the guard stops reading — which would mean rewriting the guard,
  the decorator, and `authenticated-request.ts` for no behavioural gain.

No `QueryBus` is introduced. A bus with nothing to dispatch is a file that has to be read
and explained.

### Commands carry primitives, not DTO instances

`RegisterCommand` and `LoginCommand` take `email` and `password` as `string`s. A DTO is an
HTTP-transport object carrying class-validator decorators; a handler that accepts one cannot
be exercised without constructing a web-layer object, and the handler would silently depend
on validation having already run.

### `AuthService` is deleted, split into two providers

`TokenService` owns `issueToken`. `PasswordService` owns `hash`, `verify` (the
swallow-and-return-false variant), and the `dummyHash` built in `OnModuleInit` together with
the `verifyDummy` call that spends it. Each class then has one purpose, and the
account-enumeration defence lives in one documented place instead of being inlined into the
login handler where a later edit can lose it.

### No events, no sagas

No `UserRegisteredEvent`, no `EventBus` publishing, no saga. There is no subscriber to
publish to. `CqrsModule` is present for when one genuinely appears.

## Target layout

```
src/modules/auth/
  auth.module.ts                imports CqrsModule + JwtModule; registers handlers and services
  auth.controller.ts            injects CommandBus only; routes and decorators unchanged
  commands/
    register.command.ts         RegisterCommand(email, password)
    login.command.ts            LoginCommand(email, password)
    handlers/
      register.handler.ts       @CommandHandler(RegisterCommand)
      login.handler.ts          @CommandHandler(LoginCommand)
  services/
    token.service.ts            issueToken(userId): Promise<AuthResponse>
    password.service.ts         hash, verify, verifyDummy; OnModuleInit
  dto/                          unchanged
  email.ts                      unchanged
  jwt-auth.guard.ts             unchanged
  current-user.decorator.ts     unchanged
  authenticated-request.ts      unchanged
  auth.service.ts               deleted
```

## Data flow

**`POST /api/auth/register`** — global `ValidationPipe` validates `RegisterDto` →
controller constructs `RegisterCommand` from its fields → `commandBus.execute` →
`RegisterHandler` hashes through `PasswordService`, inserts through `PrismaService` with
`displayNameFromEmail`, returns `TokenService.issueToken(user.id)`.

**`POST /api/auth/login`** — validated `LoginDto` → `LoginCommand` → `LoginHandler` reads
the user by email. On a miss it calls `PasswordService.verifyDummy(password)` and throws
`UnauthorizedException(INVALID_CREDENTIALS)`; on a hit that fails verification it throws the
same exception with the same message; otherwise it returns
`TokenService.issueToken(user.id)`.

**`GET /api/auth/me`** — unchanged. `JwtAuthGuard` verifies the token and loads the user;
`@CurrentUser` returns it. No bus involvement.

## Error handling

Behaviour is unchanged, and that is the point.

- The Prisma `P2002` unique violation maps to `ConflictException('That email is already
registered')` inside `RegisterHandler`. The comment explaining that the unique index
  decides — not a preceding `findUnique` — moves with the code.
- Both login failure paths throw the single shared `INVALID_CREDENTIALS` message. The
  comment explaining that a distinct "no such user" would make the endpoint an
  account-enumeration oracle moves to `LoginHandler`; the timing half of that defence is
  documented on `PasswordService`.
- `@nestjs/cqrs` propagates handler exceptions out of `commandBus.execute`, so
  `HttpExceptionFilter` sees exactly the exceptions it sees today and the wire format does
  not move.

## Testing

The three e2e specs (`auth-register`, `auth-login`, `auth-me`) are the contract. They must
pass **without modification** — any edit to them means the refactor changed observable
behaviour and needs to be reconsidered rather than accommodated. They require
`docker compose up -d postgres` and a migrated schema, and are run explicitly:
`pnpm --filter=@repo/api test:e2e`.

Two unit specs are added, which the previous shape made awkward and this one makes cheap:

- `register.handler.spec.ts` — a `PrismaClientKnownRequestError` with code `P2002` becomes a
  `ConflictException`; any other error propagates untouched.
- `login.handler.spec.ts` — the missing-user path and the wrong-password path both throw the
  same message, and the missing-user path still performs a verification (the timing defence
  is exercised, not merely present).

Verification order matches CI: `pnpm format:check` → `pnpm lint` → `pnpm build` →
`pnpm typecheck` → `pnpm test`, then `test:e2e` separately.

## Documentation

`apps/api/CLAUDE.md` currently names `src/modules/auth` as the module shape to copy for
anything with DTOs, a guard, or database access. Once auth is the only CQRS module, that
pointer teaches CQRS as the house style. Update it, in both `CLAUDE.md` and `AGENTS.md` and
in the same commit as the code:

- Repoint the "copy this" reference for an ordinary feature module at `src/modules/health`.
- Add a short note that auth is deliberately CQRS and that new modules should not adopt it
  by default.
- Extend the layout tree with `commands/` and `services/` under `modules/auth`.

`diff CLAUDE.md AGENTS.md` must print nothing in `apps/api` afterwards. The root guide needs
no change: no package, script, task-graph, lint, or environment change is involved.

## Out of scope

Refresh tokens, token revocation, password reset, rate limiting, a query side, domain
events, and any change to `apps/web`.
