# Auth CQRS Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure `apps/api/src/modules/auth` so register and login are command objects dispatched through `@nestjs/cqrs`'s `CommandBus`, with no observable change to the HTTP contract.

**Architecture:** `AuthService` is dissolved into two single-purpose providers (`PasswordService`, `TokenService`) plus one handler class per write operation (`RegisterHandler`, `LoginHandler`). `AuthController` ends up depending on `CommandBus` alone. `JwtAuthGuard` and `GET /me` are not touched at all. The work is sequenced so the three e2e specs pass after **every** task, not just at the end.

**Tech Stack:** Nest.js 11, `@nestjs/cqrs` 11.0.3, Prisma 7 (client generated into `src/generated/prisma`), `@nestjs/jwt`, `@node-rs/argon2`, Jest + Supertest.

**Spec:** [`docs/superpowers/specs/2026-07-30-auth-cqrs-refactor-design.md`](../specs/2026-07-30-auth-cqrs-refactor-design.md)

## Global Constraints

- **The three e2e specs must pass unmodified.** `apps/api/test/auth-register.e2e-spec.ts`, `auth-login.e2e-spec.ts`, `auth-me.e2e-spec.ts` are the contract. If one needs editing, behaviour changed and the task is wrong — stop and report rather than adjusting the test.
- **No change to routes, status codes, response bodies, or error messages.** `POST /api/auth/register` → 201, `POST /api/auth/login` → 200, `GET /api/auth/me` → 200. The login failure message is exactly `Invalid email or password` on both failure paths. The duplicate-email message is exactly `That email is already registered`.
- **Do not touch** `jwt-auth.guard.ts`, `current-user.decorator.ts`, `authenticated-request.ts`, `dto/`, or `email.ts`. No `QueryBus`, no `EventBus`, no events, no sagas.
- **Prisma client is imported from `../../generated/prisma/client`**, never from `@prisma/client`. Adjust the `../` depth for the importing file's directory.
- **Import injectable classes as values, not types.** `apps/api/**` turns off `typescript/consistent-type-imports` because Nest resolves constructor dependencies from emitted decorator metadata, which `import type` erases. `import type` is still correct for pure types like `AuthResponse` and `User`.
- **TypeScript is strict**, including `noUncheckedIndexedAccess`, `noUnusedLocals`, and `noUnusedParameters`. `typescript/no-explicit-any` is an **error** — no `any` anywhere, including in test mocks.
- **Exact dependency versions.** `package.json` pins without `^`. Install with `--save-exact` and check the written entry.
- **Conventional Commits**, enforced by commitlint. `lint-staged` runs oxfmt and `oxlint --fix` on commit, so a commit may reformat your files — that is expected.
- **Formatting/linting is Oxfmt + Oxlint**, never Prettier/ESLint. Do not add per-package config.
- **Mock typing.** The specs below use `@types/jest`'s two-parameter form, `jest.fn<TReturn, TArgs>()`. If ts-jest rejects it on this version, drop to a bare `jest.fn()` — never reach for `any` to silence it.
- **Verification order is `build` before `typecheck`** — `@repo/shared` must emit its `.d.ts` files first.

## File Structure

| File                                                          | Responsibility                                                             | Task    |
| ------------------------------------------------------------- | -------------------------------------------------------------------------- | ------- |
| `src/modules/auth/services/password.service.ts`               | argon2 hashing, tolerant verification, and the dummy-hash timing defence   | 1       |
| `src/modules/auth/services/password.service.spec.ts`          | Unit spec for the above                                                    | 1       |
| `src/modules/auth/services/token.service.ts`                  | Signing the access token — the only place the JWT payload shape is decided | 1       |
| `src/modules/auth/services/token.service.spec.ts`             | Unit spec for the above                                                    | 1       |
| `src/modules/auth/commands/register.command.ts`               | `RegisterCommand` value object                                             | 2       |
| `src/modules/auth/commands/handlers/register.handler.ts`      | Registration use case, including the P2002 → 409 mapping                   | 2       |
| `src/modules/auth/commands/handlers/register.handler.spec.ts` | Unit spec for the above                                                    | 2       |
| `src/modules/auth/commands/login.command.ts`                  | `LoginCommand` value object                                                | 3       |
| `src/modules/auth/commands/handlers/login.handler.ts`         | Login use case, including the anti-enumeration defence                     | 3       |
| `src/modules/auth/commands/handlers/login.handler.spec.ts`    | Unit spec for the above                                                    | 3       |
| `src/modules/auth/auth.controller.ts`                         | HTTP edge — DTO in, command out                                            | 2, 3    |
| `src/modules/auth/auth.module.ts`                             | Wiring                                                                     | 1, 2, 3 |
| `src/modules/auth/auth.service.ts`                            | Shrinks in tasks 1–2, deleted in task 3                                    | 1, 2, 3 |
| `apps/api/CLAUDE.md` + `apps/api/AGENTS.md`                   | Module-shape guidance                                                      | 4       |

---

### Task 1: Extract `PasswordService` and `TokenService`

Pure extraction. `AuthService` keeps both public methods and starts delegating, so the app behaves identically and the e2e specs stay green. No `@nestjs/cqrs` yet.

**Files:**

- Create: `apps/api/src/modules/auth/services/password.service.ts`
- Create: `apps/api/src/modules/auth/services/password.service.spec.ts`
- Create: `apps/api/src/modules/auth/services/token.service.ts`
- Create: `apps/api/src/modules/auth/services/token.service.spec.ts`
- Modify: `apps/api/src/modules/auth/auth.service.ts` (whole file)
- Modify: `apps/api/src/modules/auth/auth.module.ts` (providers array)

**Interfaces:**

- Consumes: `PrismaService` from `src/modules/prisma/prisma.service`, `JwtService` from `@nestjs/jwt`.
- Produces:
  - `PasswordService.hash(password: string): Promise<string>`
  - `PasswordService.verify(passwordHash: string, password: string): Promise<boolean>` — returns `false` instead of throwing on a malformed hash
  - `PasswordService.verifyDummy(password: string): Promise<void>` — spends the same argon2 work as a real verification
  - `TokenService.issueToken(userId: string): Promise<AuthResponse>`

- [ ] **Step 1: Write the failing specs**

Create `apps/api/src/modules/auth/services/password.service.spec.ts`:

```ts
import { Test } from '@nestjs/testing';

import { PasswordService } from './password.service';

describe('PasswordService', () => {
  let passwords: PasswordService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [PasswordService],
    }).compile();

    passwords = moduleRef.get(PasswordService);
    await passwords.onModuleInit();
  });

  it('hashes with argon2id and verifies the original password', async () => {
    const passwordHash = await passwords.hash('correct horse battery');

    expect(passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(await passwords.verify(passwordHash, 'correct horse battery')).toBe(true);
  });

  it('rejects a different password', async () => {
    const passwordHash = await passwords.hash('correct horse battery');

    expect(await passwords.verify(passwordHash, 'wrong horse battery')).toBe(false);
  });

  it('returns false rather than throwing on a malformed hash', async () => {
    await expect(passwords.verify('not-a-hash', 'anything')).resolves.toBe(false);
  });

  it('verifies against the dummy hash without throwing', async () => {
    await expect(passwords.verifyDummy('anything')).resolves.toBeUndefined();
  });
});
```

Create `apps/api/src/modules/auth/services/token.service.spec.ts`:

```ts
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';

import { TokenService } from './token.service';

describe('TokenService', () => {
  const signAsync = jest.fn<Promise<string>, [object]>();
  let tokens: TokenService;

  beforeEach(async () => {
    signAsync.mockReset().mockResolvedValue('signed.jwt.value');

    const moduleRef = await Test.createTestingModule({
      providers: [TokenService, { provide: JwtService, useValue: { signAsync } }],
    }).compile();

    tokens = moduleRef.get(TokenService);
  });

  it('signs the user id as the only claim', async () => {
    await tokens.issueToken('11111111-2222-3333-4444-555555555555');

    expect(signAsync).toHaveBeenCalledWith({ sub: '11111111-2222-3333-4444-555555555555' });
  });

  it('returns the token as the whole response', async () => {
    await expect(tokens.issueToken('any-id')).resolves.toEqual({
      accessToken: 'signed.jwt.value',
    });
  });
});
```

- [ ] **Step 2: Run the specs to verify they fail**

Run: `pnpm --filter=@repo/api exec jest auth/services`
Expected: FAIL — `Cannot find module './password.service'` and `'./token.service'`.

- [ ] **Step 3: Write `PasswordService`**

Create `apps/api/src/modules/auth/services/password.service.ts`:

```ts
import { randomUUID } from 'node:crypto';

import { Injectable, OnModuleInit } from '@nestjs/common';
import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';

/**
 * argon2id hashing plus the timing half of the account-enumeration defence. Both live here
 * so a login path that forgets to spend the dummy work is a missing call to a documented
 * method rather than a subtly absent line.
 */
@Injectable()
export class PasswordService implements OnModuleInit {
  private dummyHash = '';

  async onModuleInit(): Promise<void> {
    // Verified against when no account matches, so a miss costs the same as a hit. Without
    // it, argon2 runs only on the hit path and response time leaks which emails exist —
    // the enumeration the shared login error message is there to prevent.
    this.dummyHash = await argon2Hash(randomUUID());
  }

  hash(password: string): Promise<string> {
    return argon2Hash(password);
  }

  /** argon2 raises on a malformed hash, which for a login attempt just means "no". */
  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await argon2Verify(passwordHash, password);
    } catch {
      return false;
    }
  }

  /** Spends a verification's worth of work when there is no account to verify against. */
  async verifyDummy(password: string): Promise<void> {
    await this.verify(this.dummyHash, password);
  }
}
```

- [ ] **Step 4: Write `TokenService`**

Create `apps/api/src/modules/auth/services/token.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { AuthResponse } from '@repo/shared';

@Injectable()
export class TokenService {
  constructor(private readonly jwt: JwtService) {}

  /** The token is the whole response; `sub` is the only claim this API puts in it. */
  async issueToken(userId: string): Promise<AuthResponse> {
    return { accessToken: await this.jwt.signAsync({ sub: userId }) };
  }
}
```

- [ ] **Step 5: Run the specs to verify they pass**

Run: `pnpm --filter=@repo/api exec jest auth/services`
Expected: PASS — 6 tests across 2 suites.

- [ ] **Step 6: Make `AuthService` delegate**

Replace the whole of `apps/api/src/modules/auth/auth.service.ts` with:

```ts
import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { AuthResponse, Credentials } from '@repo/shared';

import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { displayNameFromEmail } from './email';
import { PasswordService } from './services/password.service';
import { TokenService } from './services/token.service';

/**
 * One message for every login failure. A distinct "no such user" would turn this endpoint
 * into an account-enumeration oracle.
 */
const INVALID_CREDENTIALS = 'Invalid email or password';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
  ) {}

  async register({ email, password }: Credentials): Promise<AuthResponse> {
    const passwordHash = await this.passwords.hash(password);

    try {
      const user = await this.prisma.user.create({
        data: { email, passwordHash, displayName: displayNameFromEmail(email) },
      });

      return await this.tokens.issueToken(user.id);
    } catch (error) {
      // The unique index decides, not a preceding read: two concurrent registrations of the
      // same address both pass a `findUnique` check, and only one can survive the insert.
      if (isUniqueViolation(error)) {
        throw new ConflictException('That email is already registered');
      }

      throw error;
    }
  }

  async login({ email, password }: Credentials): Promise<AuthResponse> {
    const user = await this.prisma.user.findUnique({ where: { email } });

    if (user === null) {
      await this.passwords.verifyDummy(password);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    if (!(await this.passwords.verify(user.passwordHash, password))) {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    return this.tokens.issueToken(user.id);
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
```

- [ ] **Step 7: Register the new providers**

In `apps/api/src/modules/auth/auth.module.ts`, add the two imports and extend `providers`:

```ts
import { PasswordService } from './services/password.service';
import { TokenService } from './services/token.service';
```

```ts
  providers: [AuthService, PasswordService, TokenService, JwtAuthGuard],
```

- [ ] **Step 8: Verify the whole package**

Run: `pnpm build --filter=@repo/api && pnpm typecheck --filter=@repo/api && pnpm --filter=@repo/api test && pnpm lint`
Expected: all green.

- [ ] **Step 9: Verify behaviour is unchanged end to end**

Requires Postgres: `docker compose up -d postgres` and a migrated schema (`pnpm --filter=@repo/api prisma:migrate`).

Run: `pnpm --filter=@repo/api test:e2e`
Expected: PASS, with **no edits** to any `*.e2e-spec.ts`. Note that this truncates the `users` table in whatever database `DATABASE_URL` points at.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/modules/auth
git commit -m "refactor(api): extract PasswordService and TokenService from AuthService"
```

---

### Task 2: Add `@nestjs/cqrs` and move register onto the `CommandBus`

**Files:**

- Modify: `apps/api/package.json` (dependencies)
- Create: `apps/api/src/modules/auth/commands/register.command.ts`
- Create: `apps/api/src/modules/auth/commands/handlers/register.handler.ts`
- Create: `apps/api/src/modules/auth/commands/handlers/register.handler.spec.ts`
- Modify: `apps/api/src/modules/auth/auth.controller.ts`
- Modify: `apps/api/src/modules/auth/auth.module.ts`
- Modify: `apps/api/src/modules/auth/auth.service.ts` (drop `register`)

**Interfaces:**

- Consumes: `PasswordService.hash`, `TokenService.issueToken` from Task 1.
- Produces:
  - `class RegisterCommand { constructor(readonly email: string, readonly password: string) {} }`
  - `RegisterHandler` implementing `ICommandHandler<RegisterCommand, AuthResponse>`, registered as a provider.

- [ ] **Step 1: Install the dependency**

```bash
pnpm --filter=@repo/api add @nestjs/cqrs@11.0.3 --save-exact
```

Then confirm two things:

1. `apps/api/package.json` reads `"@nestjs/cqrs": "11.0.3"` — no `^`. Fix by hand and re-run `pnpm install` if pnpm added one.
2. The install emitted **no** blocked-build warning for `@nestjs/cqrs`. It is pure JavaScript with no install script, so no `allowBuilds` entry in `pnpm-workspace.yaml` should be needed. If pnpm does report a blocked build, add it there with a comment saying what it builds.

- [ ] **Step 2: Write the failing spec**

Create `apps/api/src/modules/auth/commands/handlers/register.handler.spec.ts`:

```ts
import { ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { Prisma } from '../../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { PasswordService } from '../../services/password.service';
import { TokenService } from '../../services/token.service';
import { RegisterCommand } from '../register.command';
import { RegisterHandler } from './register.handler';

describe('RegisterHandler', () => {
  const create = jest.fn();
  const hash = jest.fn<Promise<string>, [string]>();
  const issueToken = jest.fn();
  let handler: RegisterHandler;

  beforeEach(async () => {
    create.mockReset().mockResolvedValue({ id: 'user-id' });
    hash.mockReset().mockResolvedValue('hashed-password');
    issueToken.mockReset().mockResolvedValue({ accessToken: 'signed.jwt.value' });

    const moduleRef = await Test.createTestingModule({
      providers: [
        RegisterHandler,
        { provide: PrismaService, useValue: { user: { create } } },
        { provide: PasswordService, useValue: { hash } },
        { provide: TokenService, useValue: { issueToken } },
      ],
    }).compile();

    handler = moduleRef.get(RegisterHandler);
  });

  it('stores the hash, never the password, and derives the display name', async () => {
    await handler.execute(new RegisterCommand('ada+test@example.com', 'correct horse'));

    expect(hash).toHaveBeenCalledWith('correct horse');
    expect(create).toHaveBeenCalledWith({
      data: {
        email: 'ada+test@example.com',
        passwordHash: 'hashed-password',
        displayName: 'ada+test',
      },
    });
  });

  it('issues a token for the created user', async () => {
    const result = await handler.execute(new RegisterCommand('ada@example.com', 'pw'));

    expect(issueToken).toHaveBeenCalledWith('user-id');
    expect(result).toEqual({ accessToken: 'signed.jwt.value' });
  });

  it('maps the unique-index violation to a 409', async () => {
    create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '7.9.1',
      }),
    );

    await expect(handler.execute(new RegisterCommand('taken@example.com', 'pw'))).rejects.toThrow(
      new ConflictException('That email is already registered'),
    );
  });

  it('lets any other database error through untouched', async () => {
    create.mockRejectedValue(new Error('connection reset'));

    await expect(handler.execute(new RegisterCommand('ada@example.com', 'pw'))).rejects.toThrow(
      'connection reset',
    );
  });
});
```

- [ ] **Step 3: Run the spec to verify it fails**

Run: `pnpm --filter=@repo/api exec jest register.handler`
Expected: FAIL — `Cannot find module '../register.command'`.

- [ ] **Step 4: Write the command**

Create `apps/api/src/modules/auth/commands/register.command.ts`:

```ts
/**
 * Primitives, not the DTO: a DTO is an HTTP-transport object carrying class-validator
 * decorators, and a handler that accepted one could not be exercised without building a
 * web-layer object.
 */
export class RegisterCommand {
  constructor(
    readonly email: string,
    readonly password: string,
  ) {}
}
```

- [ ] **Step 5: Write the handler**

Create `apps/api/src/modules/auth/commands/handlers/register.handler.ts`:

```ts
import { ConflictException } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import type { AuthResponse } from '@repo/shared';

import { Prisma } from '../../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { displayNameFromEmail } from '../../email';
import { PasswordService } from '../../services/password.service';
import { TokenService } from '../../services/token.service';
import { RegisterCommand } from '../register.command';

@CommandHandler(RegisterCommand)
export class RegisterHandler implements ICommandHandler<RegisterCommand, AuthResponse> {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
  ) {}

  async execute({ email, password }: RegisterCommand): Promise<AuthResponse> {
    const passwordHash = await this.passwords.hash(password);

    try {
      const user = await this.prisma.user.create({
        data: { email, passwordHash, displayName: displayNameFromEmail(email) },
      });

      return await this.tokens.issueToken(user.id);
    } catch (error) {
      // The unique index decides, not a preceding read: two concurrent registrations of the
      // same address both pass a `findUnique` check, and only one can survive the insert.
      if (isUniqueViolation(error)) {
        throw new ConflictException('That email is already registered');
      }

      throw error;
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
```

- [ ] **Step 6: Run the spec to verify it passes**

Run: `pnpm --filter=@repo/api exec jest register.handler`
Expected: PASS — 4 tests.

- [ ] **Step 7: Wire the module**

In `apps/api/src/modules/auth/auth.module.ts`, add:

```ts
import { CqrsModule } from '@nestjs/cqrs';

import { RegisterHandler } from './commands/handlers/register.handler';
```

Add `CqrsModule` as the **first** entry of `imports` (leave the existing `JwtModule.registerAsync({ ... })` block exactly as it is), and add `RegisterHandler` to `providers`:

```ts
  imports: [CqrsModule, JwtModule.registerAsync({ /* unchanged */ })],
  controllers: [AuthController],
  providers: [AuthService, RegisterHandler, PasswordService, TokenService, JwtAuthGuard],
```

`CqrsModule` is imported here rather than registered globally: no other module uses commands, and a global registration would advertise a house style the codebase does not have.

- [ ] **Step 8: Point the route at the bus**

In `apps/api/src/modules/auth/auth.controller.ts`, add the imports:

```ts
import { CommandBus } from '@nestjs/cqrs';

import { RegisterCommand } from './commands/register.command';
```

Add `CommandBus` to the constructor alongside the still-needed `AuthService`, and rewrite the register route. Leave `login` and `me` alone for now:

```ts
  constructor(
    private readonly auth: AuthService,
    private readonly commandBus: CommandBus,
  ) {}

  @Post('register')
  register(@Body() { email, password }: RegisterDto): Promise<AuthResponse> {
    return this.commandBus.execute<RegisterCommand, AuthResponse>(
      new RegisterCommand(email, password),
    );
  }
```

The explicit type arguments matter: `CommandBus.execute` is generic and defaults its result to `any`, which the lint config rejects.

- [ ] **Step 9: Drop `register` from `AuthService`**

Delete the `register` method and the now-unused `isUniqueViolation` helper, the `ConflictException` import, the `Prisma` import, and the `displayNameFromEmail` import from `apps/api/src/modules/auth/auth.service.ts`. What remains is the `login` method, its `INVALID_CREDENTIALS` constant, and the `PrismaService` / `PasswordService` / `TokenService` constructor. `noUnusedLocals` will catch anything you miss.

- [ ] **Step 10: Verify**

Run: `pnpm build --filter=@repo/api && pnpm typecheck --filter=@repo/api && pnpm --filter=@repo/api test && pnpm lint`
Expected: all green.

Run: `pnpm --filter=@repo/api test:e2e`
Expected: PASS, unmodified. `auth-register.e2e-spec.ts` is the one that matters here — it now exercises the bus.

- [ ] **Step 11: Commit**

```bash
git add apps/api/package.json apps/api/src/modules/auth pnpm-lock.yaml
git commit -m "refactor(api): dispatch registration through the CQRS command bus"
```

---

### Task 3: Move login onto the `CommandBus` and delete `AuthService`

**Files:**

- Create: `apps/api/src/modules/auth/commands/login.command.ts`
- Create: `apps/api/src/modules/auth/commands/handlers/login.handler.ts`
- Create: `apps/api/src/modules/auth/commands/handlers/login.handler.spec.ts`
- Modify: `apps/api/src/modules/auth/auth.controller.ts`
- Modify: `apps/api/src/modules/auth/auth.module.ts`
- Delete: `apps/api/src/modules/auth/auth.service.ts`

**Interfaces:**

- Consumes: `PasswordService.verify`, `PasswordService.verifyDummy`, `TokenService.issueToken` from Task 1; the `CqrsModule` wiring from Task 2.
- Produces:
  - `class LoginCommand { constructor(readonly email: string, readonly password: string) {} }`
  - `LoginHandler` implementing `ICommandHandler<LoginCommand, AuthResponse>`, registered as a provider.
  - After this task, `AuthController` depends on `CommandBus` only.

- [ ] **Step 1: Write the failing spec**

Create `apps/api/src/modules/auth/commands/handlers/login.handler.spec.ts`:

```ts
import { UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { PrismaService } from '../../../prisma/prisma.service';
import { PasswordService } from '../../services/password.service';
import { TokenService } from '../../services/token.service';
import { LoginCommand } from '../login.command';
import { LoginHandler } from './login.handler';

describe('LoginHandler', () => {
  const findUnique = jest.fn();
  const verify = jest.fn<Promise<boolean>, [string, string]>();
  const verifyDummy = jest.fn<Promise<void>, [string]>();
  const issueToken = jest.fn();
  let handler: LoginHandler;

  beforeEach(async () => {
    findUnique.mockReset().mockResolvedValue({ id: 'user-id', passwordHash: 'stored-hash' });
    verify.mockReset().mockResolvedValue(true);
    verifyDummy.mockReset().mockResolvedValue(undefined);
    issueToken.mockReset().mockResolvedValue({ accessToken: 'signed.jwt.value' });

    const moduleRef = await Test.createTestingModule({
      providers: [
        LoginHandler,
        { provide: PrismaService, useValue: { user: { findUnique } } },
        { provide: PasswordService, useValue: { verify, verifyDummy } },
        { provide: TokenService, useValue: { issueToken } },
      ],
    }).compile();

    handler = moduleRef.get(LoginHandler);
  });

  it('issues a token when the password verifies', async () => {
    const result = await handler.execute(new LoginCommand('ada@example.com', 'correct horse'));

    expect(findUnique).toHaveBeenCalledWith({ where: { email: 'ada@example.com' } });
    expect(verify).toHaveBeenCalledWith('stored-hash', 'correct horse');
    expect(issueToken).toHaveBeenCalledWith('user-id');
    expect(result).toEqual({ accessToken: 'signed.jwt.value' });
  });

  it('rejects a wrong password with the shared message', async () => {
    verify.mockResolvedValue(false);

    await expect(handler.execute(new LoginCommand('ada@example.com', 'wrong'))).rejects.toThrow(
      new UnauthorizedException('Invalid email or password'),
    );
    expect(issueToken).not.toHaveBeenCalled();
  });

  it('gives an unknown email the identical message', async () => {
    findUnique.mockResolvedValue(null);

    await expect(handler.execute(new LoginCommand('nobody@example.com', 'pw'))).rejects.toThrow(
      new UnauthorizedException('Invalid email or password'),
    );
  });

  it('still spends verification work when no account matches', async () => {
    findUnique.mockResolvedValue(null);

    await expect(handler.execute(new LoginCommand('nobody@example.com', 'pw'))).rejects.toThrow(
      UnauthorizedException,
    );
    // Without this, argon2 runs only on the hit path and response time tells an attacker
    // which addresses have accounts — the enumeration the shared message exists to prevent.
    expect(verifyDummy).toHaveBeenCalledWith('pw');
  });
});
```

- [ ] **Step 2: Run the spec to verify it fails**

Run: `pnpm --filter=@repo/api exec jest login.handler`
Expected: FAIL — `Cannot find module '../login.command'`.

- [ ] **Step 3: Write the command**

Create `apps/api/src/modules/auth/commands/login.command.ts`:

```ts
export class LoginCommand {
  constructor(
    readonly email: string,
    readonly password: string,
  ) {}
}
```

- [ ] **Step 4: Write the handler**

Create `apps/api/src/modules/auth/commands/handlers/login.handler.ts`:

```ts
import { UnauthorizedException } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import type { AuthResponse } from '@repo/shared';

import { PrismaService } from '../../../prisma/prisma.service';
import { PasswordService } from '../../services/password.service';
import { TokenService } from '../../services/token.service';
import { LoginCommand } from '../login.command';

/**
 * One message for every login failure. A distinct "no such user" would turn this endpoint
 * into an account-enumeration oracle.
 */
const INVALID_CREDENTIALS = 'Invalid email or password';

@CommandHandler(LoginCommand)
export class LoginHandler implements ICommandHandler<LoginCommand, AuthResponse> {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
  ) {}

  async execute({ email, password }: LoginCommand): Promise<AuthResponse> {
    const user = await this.prisma.user.findUnique({ where: { email } });

    if (user === null) {
      // Costs what a real verification costs, so the response time does not reveal that
      // no account matched.
      await this.passwords.verifyDummy(password);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    if (!(await this.passwords.verify(user.passwordHash, password))) {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    return this.tokens.issueToken(user.id);
  }
}
```

- [ ] **Step 5: Run the spec to verify it passes**

Run: `pnpm --filter=@repo/api exec jest login.handler`
Expected: PASS — 4 tests.

- [ ] **Step 6: Point the route at the bus and drop `AuthService` from the controller**

`apps/api/src/modules/auth/auth.controller.ts` in full:

```ts
import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import type { AuthResponse, User } from '@repo/shared';

import { LoginCommand } from './commands/login.command';
import { RegisterCommand } from './commands/register.command';
import { CurrentUser } from './current-user.decorator';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { JwtAuthGuard } from './jwt-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly commandBus: CommandBus) {}

  @Post('register')
  register(@Body() { email, password }: RegisterDto): Promise<AuthResponse> {
    return this.commandBus.execute<RegisterCommand, AuthResponse>(
      new RegisterCommand(email, password),
    );
  }

  /** 200, not the 201 Nest gives a POST by default: logging in creates nothing. */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() { email, password }: LoginDto): Promise<AuthResponse> {
    return this.commandBus.execute<LoginCommand, AuthResponse>(new LoginCommand(email, password));
  }

  /** Served entirely by the guard: it loads the user, this returns it. No bus involved. */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: User): User {
    return user;
  }
}
```

- [ ] **Step 7: Delete `AuthService` and finish the module**

```bash
git rm apps/api/src/modules/auth/auth.service.ts
```

`apps/api/src/modules/auth/auth.module.ts` in full:

```ts
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CqrsModule } from '@nestjs/cqrs';
import { JwtModule } from '@nestjs/jwt';

import { AuthController } from './auth.controller';
import { LoginHandler } from './commands/handlers/login.handler';
import { RegisterHandler } from './commands/handlers/register.handler';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PasswordService } from './services/password.service';
import { TokenService } from './services/token.service';

@Module({
  imports: [
    // Imported here rather than registered globally: no other module uses commands, and a
    // global registration would advertise a house style the rest of the app does not follow.
    CqrsModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: {
          algorithm: 'HS256',
          expiresIn: config.getOrThrow<number>('JWT_EXPIRES_IN_SECONDS'),
        },
        // Also set per call in JwtAuthGuard. Stated twice on purpose: a verify that forgets
        // it accepts `alg: none`, so the safe value is the default here as well.
        verifyOptions: { algorithms: ['HS256'] },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [RegisterHandler, LoginHandler, PasswordService, TokenService, JwtAuthGuard],
})
export class AuthModule {}
```

- [ ] **Step 8: Confirm `AuthService` is gone from the codebase**

Run: `grep -rn "AuthService" apps packages --include="*.ts" | grep -v generated/prisma`
Expected: no output.

- [ ] **Step 9: Verify**

Run: `pnpm build --filter=@repo/api && pnpm typecheck --filter=@repo/api && pnpm --filter=@repo/api test && pnpm lint`
Expected: all green, 14 unit tests across the auth module.

Run: `pnpm --filter=@repo/api test:e2e`
Expected: PASS, with no edits to any `*.e2e-spec.ts`. This is the moment the refactor is proven: all three routes now run on the final structure.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/modules/auth
git commit -m "refactor(api): dispatch login through the CQRS command bus"
```

---

### Task 4: Update the API guide

`apps/api/CLAUDE.md` currently points at `src/modules/auth` as the module shape to copy. Once auth is the only CQRS module, that pointer teaches CQRS as the default. The two files are byte-identical mirrors — edit one, copy it over the other, never retype.

**Files:**

- Modify: `apps/api/CLAUDE.md`
- Modify: `apps/api/AGENTS.md` (by copy)

- [ ] **Step 1: Update the layout tree**

In `apps/api/CLAUDE.md`, in the `## Layout` code block, replace this line:

```
  modules/<feature>/    One directory per feature: module, controller, service, spec
```

with:

```
  modules/<feature>/    One directory per feature: module, controller, service, spec
                        auth/ additionally: commands/ (command + handler per use case),
                        services/ (PasswordService, TokenService)
```

- [ ] **Step 2: Repoint the reference-shape sentence**

Immediately below that block, replace:

```
`src/modules/health` is the reference shape for a trivial feature module;
`src/modules/auth` is the one to copy for anything with DTOs, a guard, or database access.
```

with:

```
`src/modules/health` is the reference shape for a feature module — controller, service,
module. Copy that. `src/modules/auth` is the place to read for DTO validation, a guard, and
database access, but **do not copy its structure**: it is deliberately CQRS
(`@nestjs/cqrs`, one command class and handler per write operation) and no other module is.
A new feature adopts CQRS only on purpose, not by imitation.
```

- [ ] **Step 3: Add a revisit trigger**

In the `## Keeping this guide current` list, after the bullet beginning `**The module conventions shift**`, add:

```
- **A second module adopts CQRS** — the auth module is currently the only one, which is why
  the layout section calls it an exception. If commands become the norm, that framing is
  wrong and the reference shape has to be re-decided rather than quietly re-pointed.
```

- [ ] **Step 4: Mirror and verify**

```bash
cp apps/api/CLAUDE.md apps/api/AGENTS.md
for d in . apps/web apps/api; do diff "$d/CLAUDE.md" "$d/AGENTS.md" || echo "drift: $d"; done
```

Expected: no output at all. Any `drift:` line means a pair disagrees and must be reconciled before committing.

- [ ] **Step 5: Full CI-order verification**

Run from the repository root, in this order:

```bash
pnpm format:check && pnpm lint && pnpm build && pnpm typecheck && pnpm test
```

Expected: all green. Then, with Postgres up: `pnpm --filter=@repo/api test:e2e` — PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/CLAUDE.md apps/api/AGENTS.md
git commit -m "docs(api): note that auth is deliberately CQRS and not the module template"
```

---

## Done when

- `AuthController` depends on `CommandBus` alone; `auth.service.ts` no longer exists.
- `RegisterHandler` and `LoginHandler` each own one use case, with `PasswordService` and `TokenService` as their only non-Prisma collaborators.
- `JwtAuthGuard`, `current-user.decorator.ts`, `authenticated-request.ts`, `dto/`, and `email.ts` are byte-identical to what they were before this plan started.
- All three e2e specs pass **unmodified**, and 14 new/moved unit tests pass.
- `diff CLAUDE.md AGENTS.md` prints nothing in all three directories.
