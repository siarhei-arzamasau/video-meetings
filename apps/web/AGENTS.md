# Package guide — `@repo/web`

> **`CLAUDE.md` and `AGENTS.md` in this directory are byte-identical mirrors.** Edit one,
> then `cp CLAUDE.md AGENTS.md`; `diff CLAUDE.md AGENTS.md` must print nothing. Below,
> **"this guide"** means both files together.

The Next.js 16 frontend. Read [the root guide](../../CLAUDE.md) first for workspace-wide
commands and conventions.

## Stack

Next.js 16 (App Router) · React 19 · HeroUI 3 · Tailwind CSS 4 · next-themes · Vitest +
jsdom.

## Commands

```bash
pnpm --filter=@repo/web dev          # next dev on :3000, or $WEB_PORT
pnpm --filter=@repo/web build        # next build (standalone output)
pnpm --filter=@repo/web typecheck    # needs a prior build for .next/types
pnpm --filter=@repo/web test         # vitest run
pnpm --filter=@repo/web test:watch
```

## Every change is checked against `ui-ux-pro-max`

**No change in this app is complete until it has been tested against the `ui-ux-pro-max`
skill.** Invoke it and apply what it says about the surfaces you touched — style, colour,
typography, layout, accessibility, motion, data visualisation. This is a completion gate,
not a suggestion: passing tests and a green build are not "done" on their own.

"This change isn't visual" does not exempt it. A helper in `src/lib` or a shape in
`@repo/shared` changes what the user sees the moment a component reads it, so the check
applies to any change here.

**The inspection happens in a real browser, driven through the Playwright MCP server** — the
one [the root guide](../../CLAUDE.md#agent-tooling) declares in `.mcp.json`. Start the app
(`pnpm --filter=@repo/web dev`, :3000 — or the port `pnpm dev` reported, which is not always
3000), navigate to the routes you touched, and look at the
rendered page. Reading the JSX is not inspection: layout, spacing, contrast, focus rings, and
theming only exist once Tailwind and HeroUI have run. Cover both themes and at least one
narrow viewport, and check the browser console is clean while you are there.

State the outcome alongside the change: what the skill flagged, what the browser showed, and
what you did about each item — or that both came back clean. An unreported check is
indistinguishable from a skipped one.

## Layout

```
src/
  app/            App Router: layout, page, error, not-found, providers, globals.css
  components/     Shared React components
  lib/            Non-React helpers, including the API client
```

`@/*` maps to `./src/*` in both `tsconfig.json` and `vitest.config.ts` — keep the two
aliases in sync if either changes.

## Things that are load-bearing

- **`src/app/globals.css` import order.** `@import 'tailwindcss'` must come before
  `@import '@heroui/styles'`. The `@custom-variant dark (&:where(.dark, .dark *))` line
  points Tailwind's `dark:` variant at the class next-themes sets, instead of the default
  `prefers-color-scheme` media query. Changing either breaks theming.
- **`src/app/providers.tsx`.** HeroUI v3 needs no provider of its own; this file exists for
  next-themes, which must set both `class` and `data-theme` because HeroUI reads the two
  together.
- **`suppressHydrationWarning` on `<html>`** in `layout.tsx` — next-themes writes theme
  attributes before React hydrates. Leave it.
- **`next.config.ts`** sets `output: 'standalone'` (the Dockerfile copies `.next/standalone`
  as the whole runtime), `outputFileTracingRoot` pointed at the repo root so tracing
  reaches workspace packages, `transpilePackages: ['@repo/shared']`, and a `redirects()`
  entry sending `/register` to `/auth/register` — the sign-up page lived at the old path
  before the auth pages moved under `/auth`, and a 308 keeps older links working without a
  route file whose only job is to redirect.
- **`"dev": "next dev --port ${WEB_PORT:-3000}"` is shell interpolation, and deliberate.** It
  looks like a stray `$` in JSON; package scripts run through `sh`, so it expands. It exists
  because `next dev` reads `PORT`, which belongs to the API here — the two apps would fight over
  one variable. The root `pnpm dev` sets `WEB_PORT`; the `:-3000` covers running this app alone.
  A `WEB_PORT` in `.env.local` will _not_ be seen, because the shell expands this before Next
  loads any env file. Export it or use `--port`.
- **A React Aria `validationErrors` object must keep its identity between renders.** React
  Aria resets its "the user has edited this field since" flag whenever the object is not the
  one it saw last render, so a fresh `{}` literal per render pins a server-side field error
  open forever: the message never clears, and native validation then refuses to submit the
  corrected value. `auth/register/register-card.tsx` memoises it and falls back to one shared
  constant. The symptom is a form that permanently rejects input the server would now accept.
  `login-card.tsx` sidesteps the whole problem by passing no `validationErrors` at all — see
  below for why it has no field-level server errors to report.
- **Meeting times are formatted in the reader's own locale and time zone, and that is only safe
  because `/` fetches after mount.** Nothing server-rendered formats a date, so there is no
  server string for the client's to disagree with. Server-render that page — which is exactly
  what the `HttpOnly` cookie migration invites — and every `<time>` on it becomes a hydration
  mismatch. `src/lib/date-time.ts` takes an injectable formatter for tests only; production must
  keep the reader's locale, because showing `7/30/2026` to someone who reads `30/07/2026` is a
  misread date rather than a cosmetic difference.

## API access

All calls to the backend go through `src/lib/api-client.ts` — it is the single boundary
between the web app and the API. Add new endpoint wrappers there (`apiFetch<T>` plus a
named function) rather than calling `fetch` from components.

Failures throw `ApiError`, carrying the HTTP status **and the API's own message** — read out
of the `ApiErrorResponse` body, joining the one-per-rule array a validation failure returns.
That is what makes `error.message` safe to render: "That email is already registered" is not
recoverable from a 409. Reading the body must never throw, because a failing response is not
obliged to carry JSON, and a parse error raised while reporting a failure replaces the real
one. A rejection that is not an `ApiError` means the request never reached the API at all.

The base URL comes from `NEXT_PUBLIC_API_URL`, defaulting to `http://localhost:3001/api`
(origin _and_ the API's `/api` global prefix). Response shapes are imported as types from
`@repo/shared`.

**Next inlines that value into the client bundle at boot, which is why the root `pnpm dev`
resolves ports before starting anything** — see
[the root guide](../../CLAUDE.md#pnpm-dev-picks-the-ports-before-turborepo-starts). Reading it
through `process.env` at call time does not change that; the bundler substitutes the literal. The
practical consequence for this app: nothing here may treat 3001 as fixed, and the API's port is
never discovered at runtime.

**A JWT-guarded endpoint gets a wrapper whose first argument is the token** — `getMe(token)`,
`listMeetings(token)`. `apiFetch` never reads storage, and that is the point: the credential is
opt-in, so no request is authenticated by accident and `register`/`login`/`getHealth` cannot
start leaking a bearer token. It also keeps this module runnable where there is no browser. When
the API starts setting an `HttpOnly` cookie, the token parameters disappear in favour of
`credentials: 'include'` **inside this file only** — that is what the explicit argument buys, and
why the alternative (a transport that reaches into `auth-token.ts`) is the wrong shape. A test
pins that the unauthenticated wrappers send no `authorization` header; keep it.

### Client-side validation and credentials

`src/lib/credentials.ts` mirrors the API's registration rules, using the bounds exported by
`@repo/shared` rather than its own copies. Being **stricter than the server is the failure
that matters** — it rejects a value the API would have accepted and gives the user no appeal
— so the email pattern is deliberately looser than the API's `@IsEmail()`. The server keeps
the final say either way; this only saves a round trip.

**Sign-in and sign-up do not share a password check.** `validatePassword` is the registration
rule; `validateLoginPassword` is non-empty plus the length ceiling, and no minimum. That
mirrors `LoginDto`, which drops `@MinLength` on purpose so login keeps accepting whatever
registration once accepted. Using `validatePassword` on the login form is the stricter-than-
the-server failure in its most concrete form: an account whose password predates the current
minimum could never be typed into the field, and its owner has no way to appeal a rule the
API was never going to apply. The two functions looking near-identical is not an invitation
to merge them.

### Where an auth failure gets shown

`register-card.tsx` puts a 409 on the `email` field, because a taken address genuinely is
that field's problem and a banner would leave the user guessing which of two inputs to change.

`login-card.tsx` puts **everything** in the form-level `Alert`, and that asymmetry is
deliberate. The API answers `Invalid email or password` for an unknown address and a wrong
password alike — one constant, so the endpoint cannot be used to ask whether an account
exists. Attaching that message to the email field would assert which of the two was wrong,
undoing on the client the defence the server is paying an argon2 verification to maintain.

### Signed-in state

`src/lib/auth-token.ts` keeps the JWT in `localStorage`, and that is a placeholder rather
than the answer: any script the page runs can read it. The intended fix is an `HttpOnly`
cookie set by the API, at which point this module is deleted rather than extended. Do not
build more session machinery on top of it. Every access is guarded — `localStorage` throws
outright where storage is disabled — and nothing there rethrows, because losing a token is
survivable and failing a completed registration over it is not.

**Route protection is client-side only, and there is deliberately no `middleware.ts`.** The
token is in `localStorage`, which does not exist in the request middleware runs in and cannot be
read while Next renders on the server — a gate there could only pass everyone through or turn
everyone away, and the second one looks like it works when you hand-test it signed in. `/`
therefore reads the token in an effect **after mount** (never during render — a token-dependent
first render is a value the server could not have produced), holds a `loading` shell until it
knows, and `router.replace`s to `/auth/login` when there is no token or when either request
answers 401, clearing the token first because one the API has rejected is worth nothing. Two
consequences to accept rather than paper over: **`/` is prerendered, so its empty shell is
briefly visible to anyone** — nothing secret may go in it — and it is the _data_ that is
protected, never the URL. All of this collapses into a middleware redirect the moment the token
becomes an `HttpOnly` cookie, the same migration that deletes `auth-token.ts`.

**A page reading the token in one effect is not session machinery.** There is no provider, no
context, no `useSession`, no refresh, no interceptor, and there should not be — the cookie
migration throws every one of those away. If a second protected page arrives, extract the gate,
and ask first whether the cookie should land before it.

**Signing out is local**: clear the token, `replace` to `/auth/login`. There is no logout
endpoint because the JWT is stateless and stays valid until it expires. That is a property of
bearer tokens, not a gap to fill; a `POST /auth/logout` added to make the button feel symmetrical
would only pretend otherwise.

## Tests

Vitest with the jsdom environment, files matching `src/**/*.test.{ts,tsx}` next to the code
they cover. Not Jest — that's the API app.

**There are no component render tests**: `@testing-library/react` is not a dependency, and the
logic worth pinning is pushed into `src/lib` for that reason — `latestMeetings`,
`formatMeetingTime`, and the endpoint wrappers are all pure and all covered there. Adding RTL is
not one dependency (it is RTL, jest-dom, a `setupFiles` entry in a config that deliberately has
none, and explicit `afterEach(cleanup)` because `globals` is off), so it is a change to argue on
its own rather than inside a feature. What it would mostly assert here is that a component calls
the `useRouter`/`localStorage`/`fetch` mocks it was written to call; the browser inspection above
is the stronger check on everything else.

## Keeping this guide current

Update it in the same commit as the change, in **both** files.
[The root guide](../../CLAUDE.md#keeping-documentation-current) covers the general rules and
what belongs at the workspace level; this guide owns what is specific to `@repo/web`.

Revisit it when:

- **A new top-level directory appears under `src/`** — add it to the Layout section with a
  one-line statement of what belongs there.
- **Theming, the CSS import order, or the Providers tree changes** — the "Things that are
  load-bearing" section exists to stop someone from undoing those on the reasonable-looking
  assumption that they are arbitrary. Any new constraint of that kind belongs there, with
  the reason it exists; any that stops being true should be deleted.
- **`next.config.ts` gains or loses an option** — each documented option is paired with why
  it is set, so keep the pairing.
- **The API boundary moves** — if calls stop going exclusively through
  `src/lib/api-client.ts`, the API access section is now wrong and needs rewriting rather
  than amending.
- **The path alias, test runner, or test file pattern changes** — `tsconfig.json` and
  `vitest.config.ts` must stay in sync with each other and with this file.

Adding an ordinary component, route, or endpoint wrapper that follows the existing patterns
needs no update here. Document the pattern, not each instance of it.
