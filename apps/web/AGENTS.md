# Package guide — `@repo/web`

> **`AGENTS.md` is the guide; `CLAUDE.md` beside it imports it.** Write every change here.

The Next.js 16 frontend. Read [the root guide](../../AGENTS.md) first for workspace-wide
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
skill** — style, colour, typography, layout, accessibility, motion, data visualisation. It is
a completion gate, not a suggestion, and "this change isn't visual" does not exempt it: a
helper in `src/lib` or a shape in `@repo/shared` changes what the user sees the moment a
component reads it.

**The inspection happens in a real browser, driven through the Playwright MCP server** that
[the root guide](../../AGENTS.md#agent-tooling) declares. Start the app, navigate to the
routes you touched, and look at the rendered page — reading the JSX is not inspection, since
layout, spacing, contrast, focus rings, and theming only exist once Tailwind and HeroUI have
run. Cover both themes and at least one narrow viewport, and check the console is clean.

State the outcome alongside the change: what the skill flagged, what the browser showed, and
what you did about each — or that both came back clean. An unreported check is
indistinguishable from a skipped one.

## Layout

```
src/
  app/            App Router: layout, page, error, not-found, providers, globals.css
    meetings/[id] The meeting page; files/ under it is the files section
  components/     Shared React components
  lib/            Non-React helpers, including the API client and the signed-in gate
e2e/              Playwright browser suite (see Tests)
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
- **`<body>` paints its own background: `bg-background text-foreground` in `layout.tsx`.**
  Without them `html`, `body` and `main` are transparent and the page colour is the browser's
  root canvas following `color-scheme` — which matched the theme in a plain Chrome window and
  did not in an embedded one, where light mode rendered as a dark page behind a white card.
  Both are HeroUI tokens, so the two themes stay paired. Do not move this onto a page wrapper:
  every route would then have to remember it.
- **`suppressHydrationWarning` on `<html>`** in `layout.tsx` — next-themes writes theme
  attributes before React hydrates. Leave it.
- **`next.config.ts`** sets `output: 'standalone'` (the Dockerfile copies `.next/standalone`
  as the whole runtime), `outputFileTracingRoot` pointed at the repo root so tracing reaches
  workspace packages, `transpilePackages: ['@repo/shared']`, and a `redirects()` entry sending
  `/register` to `/auth/register` — a 308 keeps older links working without a route file whose
  only job is to redirect.
- **`"dev": "next dev --port ${WEB_PORT:-3000}"` is shell interpolation, and deliberate.** It
  looks like a stray `$` in JSON; package scripts run through `sh`, so it expands. It exists
  because `next dev` reads `PORT`, which belongs to the API here. A `WEB_PORT` in `.env.local`
  will _not_ be seen — the shell expands this before Next loads any env file. Export it or use
  `--port`.
- **A React Aria `validationErrors` object must keep its identity between renders.** React
  Aria resets its "edited since" flag whenever the object is not the one it saw last render, so
  a fresh `{}` literal per render pins a server-side field error open forever: the message never
  clears, and native validation then refuses to submit the corrected value.
  `auth/register/register-card.tsx` memoises it and falls back to one shared constant.
  `login-card.tsx` passes no `validationErrors` at all — see below for why it has no
  field-level server errors.
- **Meeting times are formatted in the reader's own locale and time zone, and that is only safe
  because `/` fetches after mount.** Nothing server-rendered formats a date, so there is no
  server string to disagree with the client's. Server-render that page — which the `HttpOnly`
  cookie migration invites — and every `<time>` becomes a hydration mismatch.
  `src/lib/date-time.ts` takes an injectable formatter for tests only; production keeps the
  reader's locale, because showing `7/30/2026` to someone who reads `30/07/2026` is a misread
  date rather than a cosmetic difference.
- **A killed `next dev` can leave Turbopack's cache corrupt, and the symptom looks like a
  runaway machine.** A later `next dev` says `Ready` and serves the routes whose entries
  survived; on one whose entry did not, `next-server` dies silently and each restart leaks a
  pool of PostCSS workers the dead parent never reaps — thousands of idle `node` processes
  within minutes, and a health-check URL that never answers, so the browser suite times out.
  Diagnosis: `curl` one route that works and one that hangs. Cure:
  `pnpm --filter=@repo/web clean` (it is `rm -rf .next`). Nothing in the app causes it or can
  prevent it; do not go looking there first.
- **An authenticated image needs an object URL.** The token is in `localStorage`, so an
  `<img src="/api/…/thumbnail">` would arrive with no credentials and a 401. `FileRow` fetches
  the thumbnail with the bearer header, turns the blob into `URL.createObjectURL`, and revokes
  it on unmount. Downloads work the same way. Both collapse into plain URLs once the token is
  an `HttpOnly` cookie.
- **The meeting page follows its files over SSE, and the three second poll is the fallback that
  must not be deleted.** `useMeetingFiles` opens `GET /meetings/:id/files/events` at mount
  beside the first list fetch; `applyFileEvent` replaces a known id **where it is**, re-sorts an
  unknown one in, and removes a `deleted` one, so the Processing chip goes the moment the worker
  finishes. Two rules follow from one fact — an event says what a row is now, a list says what
  every row was when the server ran the query, and the client cannot order the two:
  **the list is refetched every time a stream opens** (only a list requested after the server
  subscribed this connection holds what no event will repeat), and **events arriving during a
  fetch are replayed on top of the snapshot**, so a slow refetch cannot put a settled row back
  to Processing. **`EventSource` is not used** and cannot be while the token is in
  `localStorage`: it sends no `Authorization` header, and a token in the URL is logged by every
  proxy — the stream is opened with `fetch` and parsed by `src/lib/sse.ts`, the file the cookie
  migration deletes. `watchMeetingFiles` reopens a dropped stream (1, 2, 4 seconds); a TTL close
  is an ordinary drop. After three drops in a minute the poll takes over **for a minute
  (`STREAM_RETRY_MS`), not for good** — an API restart is exactly three drops, and a page that
  never retried would sit on the poll until reloaded. The poll stays because a stream is the
  first thing a corporate proxy or captive portal breaks. **One polite `role="status"` region**
  (`FilesSection`, visually hidden) announces how many files are processing: one per section,
  never one per row, and empty on first render so nothing is read aloud for arriving.
- **Retry on a failed row is gated exactly like Delete.** `FileRow` takes one `canManage` flag —
  uploader or host — because the API applies one rule to both and two flags could only disagree
  with it. The retry needs no local state machine: the API answers with the file as `uploaded`,
  and the list already polls while anything is. A 409 means someone else got there first, so the
  list is refetched rather than second-guessed; anything else shows inline with Dismiss.
- **A file over 100 MB is uploaded in chunks, and the row is the only part that looks
  different.** `FilesSection`'s queue routes on `isChunkedUpload`; the rest of the component
  only learns that such a row carries a session id (Cancel drops it server-side, Retry resumes).
  The client-side size check is the **chunked** cap for that reason — rejecting at 100 MB would
  refuse a file the app can perfectly well send.
- **A stored upload session id is a hint, never a promise.** A browser cannot keep a `File`
  handle across a reload, so `src/lib/upload-sessions.ts` keys the session id by
  `<name>:<size>:<lastModified>` and the re-picked file is matched to it. `uploadInChunks` asks
  the server and opens a new session when the stored one has expired or describes a different
  file, which is what makes a stale entry harmless and why nothing expires entries here.
- **The upload queue renders on `uploads.length`, not on the list being `ready`.** Add file and
  the drop target work while the list is still loading or failed, so hiding the queue there would
  swallow a rejection message and run an upload with no progress or Cancel. Pre-flight messages
  come from the `MEETING_FILE_*_MESSAGE` constants in `@repo/shared` — the same ones the API
  sends — so a file rejected here reads exactly as it would have from the server. Queue rows are
  keyed by a counter, not `crypto.randomUUID()`, which exists only in secure contexts: a dev
  server opened over plain HTTP from a phone is not one.

## API access

All calls to the backend go through `src/lib/api-client.ts` — the single boundary between the
web app and the API. Add endpoint wrappers there (`apiFetch<T>` plus a named function) rather
than calling `fetch` from components. The base URL comes from `NEXT_PUBLIC_API_URL`, defaulting
to `http://localhost:3001/api` (origin _and_ the API's `/api` prefix); response shapes are
imported as types from `@repo/shared`.

Failures throw `ApiError`, carrying the HTTP status **and the API's own message** — read out
of the `ApiErrorResponse` body, joining the one-per-rule array a validation failure returns.
That is what makes `error.message` safe to render: "That email is already registered" is not
recoverable from a 409. Reading the body must never throw, because a failing response is not
obliged to carry JSON and a parse error would replace the real failure. A rejection that is not
an `ApiError` means the request never reached the API.

Three calls are exceptions, and all three stay inside that file:

- **`uploadMeetingFile` and `putChunk` are `XMLHttpRequest`**, because `fetch` cannot report
  upload progress and the PRD asks for a percentage. Both go through one private
  `sendWithProgress`, so the exception lives in a single place; everything else about them
  matches `apiFetch`. A third caller belongs there too — nothing else in the app may open an
  `XMLHttpRequest`.
- **`openMeetingFileEvents` hands back the `Response` unread**, because the body is a
  `text/event-stream` the caller reads with `readEventStream`. It is still the same boundary —
  `buildApiUrl`, the bearer header, a non-2xx as an `ApiError` — so a 401 there reaches
  `onUnauthorized` like any other. It also checks the content type, which no other wrapper
  needs to: a proxy or misconfigured dev server can answer 200 with HTML, and read as a stream
  that is a connection which opened and closed at once — a reconnect loop rather than a visible
  failure.

**A JWT-guarded endpoint gets a wrapper whose first argument is the token** — `getMe(token)`,
`listMeetings(token)`. `apiFetch` never reads storage, so no request is authenticated by
accident and `register`/`login`/`getHealth` cannot start leaking a bearer token; it also keeps
this module runnable where there is no browser. When the API sets an `HttpOnly` cookie, those
parameters give way to `credentials: 'include'` **inside this file only** — that is what the
explicit argument buys, and why a transport reaching into `auth-token.ts` is the wrong shape.
A test pins that the unauthenticated wrappers send no `authorization` header; keep it.

Nothing here may treat 3001 as fixed, and the API's port is never discovered at runtime: Next
inlines `NEXT_PUBLIC_API_URL` into the bundle at boot, which is why the root `pnpm dev`
resolves ports first — see
[the root guide](../../AGENTS.md#pnpm-dev-picks-the-ports-before-turborepo-starts).

### Client-side validation and credentials

`src/lib/credentials.ts` mirrors the API's registration rules, using the bounds exported by
`@repo/shared` rather than its own copies. Being **stricter than the server is the failure that
matters** — it rejects a value the API would have accepted and gives the user no appeal — so
the email pattern is deliberately looser than the API's `@IsEmail()`.

**Sign-in and sign-up do not share a password check.** `validatePassword` is the registration
rule; `validateLoginPassword` is non-empty plus the length ceiling, no minimum. That mirrors
`LoginDto`, which drops `@MinLength` on purpose so login keeps accepting whatever registration
once accepted. Using `validatePassword` on the login form is the stricter-than-the-server
failure in its most concrete form: an account whose password predates the current minimum could
never be typed in. The two functions looking near-identical is not an invitation to merge them.

### Where an auth failure gets shown

`register-card.tsx` puts a 409 on the `email` field — a taken address genuinely is that field's
problem, and a banner would leave the user guessing which of two inputs to change.

`login-card.tsx` puts **everything** in the form-level `Alert`, deliberately. The API answers
`Invalid email or password` for an unknown address and a wrong password alike, so the endpoint
cannot be asked whether an account exists. Attaching that message to the email field would
assert which of the two was wrong, undoing on the client the defence the server pays an argon2
verification to maintain.

### Signed-in state

`src/lib/auth-token.ts` keeps the JWT in `localStorage`, a placeholder rather than the answer:
any script the page runs can read it. The intended fix is an `HttpOnly` cookie, at which point
this module is deleted rather than extended — do not build more session machinery on it. Every
access is guarded (`localStorage` throws outright where storage is disabled) and nothing
rethrows, because losing a token is survivable and failing a completed registration over it is
not.

**Route protection is client-side only, and there is deliberately no `middleware.ts`.** The
token is in `localStorage`, which does not exist in the request middleware runs in — a gate
there could only pass everyone through or turn everyone away, and the second looks like it
works when you hand-test it signed in. Pages therefore read the token in an effect **after
mount** (never during render), hold a `loading` shell, and `router.replace` to `/auth/login`
when there is no token or a request answers 401, clearing the token first. Two consequences to
accept rather than paper over: **a prerendered empty shell is briefly visible to anyone**, so
nothing secret goes in it, and it is the _data_ that is protected, never the URL.

**The gate is `src/lib/use-signed-in.ts`, and it is still not session machinery.** One hook
holding the token-after-mount read, `getMe`, the 401 clear-and-redirect, and a local `signOut`.
No provider, no context, no refresh, no interceptor — the cookie migration deletes this hook
along with `auth-token.ts`. A page adds only its own requests and hands a mid-page 401 back to
`signOut`.

**Signing out is local**: clear the token, `replace` to `/auth/login`. There is no logout
endpoint because the JWT is stateless and stays valid until it expires. That is a property of
bearer tokens, not a gap to fill.

## Tests

Vitest with the jsdom environment, files matching `src/**/*.test.{ts,tsx}` next to the code
they cover. Not Jest — that's the API app.

**There are no component render tests**: `@testing-library/react` is not a dependency, and the
logic worth pinning is pushed into `src/lib` for that reason. Adding RTL is not one dependency
(it is RTL, jest-dom, a `setupFiles` entry in a config that deliberately has none, and explicit
`afterEach(cleanup)` because `globals` is off), so it is a change to argue on its own rather
than inside a feature. The browser suite below is the stronger check it defers to.

### The browser suite

`pnpm --filter=@repo/web test:e2e` runs Playwright (Chromium only) over `e2e/*.spec.ts`.
`playwright.config.ts` starts both servers itself — the API through its `start:e2e-web` script
on **3101** (worker on, fast poll, temp storage) and this app on **3100** — with
`reuseExistingServer` off, one worker, and no retries. It needs `docker compose up -d postgres`,
a migrated schema, and `pnpm exec playwright install chromium` once. `E2E_SERVER_TIMEOUT_MS`
raises the two-minute wait per server; a wait that times out even at several minutes is the
corrupt-cache symptom above, not a slow machine. Its `globalTeardown` truncates `users`, so **it
must never run alongside the API's e2e suite** — they share the database. A running `next dev`
from this directory also blocks it, because Next locks `.next`.

The house convention it sets: **a new page starts as a red Playwright spec**, written against
the routes, copy, and roles the page will have, run and seen failing, then made green by the
implementation. The two specs here were written that way.

Test user, created if it does not exist: `test@example.com` / `test@example.com`.

## Keeping this guide current

Update it in the same commit as the change;
[the root guide](../../AGENTS.md#keeping-documentation-current) covers the general rules, this
one owns what is specific to `@repo/web`. Revisit it when a new top-level directory appears
under `src/`, when theming or the Providers tree changes, when `next.config.ts` gains or loses
an option (each is documented with why it is set — keep the pairing), when calls stop going
exclusively through `src/lib/api-client.ts` (the API access section is then wrong and needs
rewriting rather than amending), or when the path alias, test runner, or test file pattern
changes. Adding an ordinary component, route, or endpoint wrapper that follows the existing
patterns needs no update.
