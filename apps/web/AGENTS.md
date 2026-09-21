# Package guide — `@repo/web`

> **`AGENTS.md` is the guide; `CLAUDE.md` beside it imports it.** Write every change here.

The Next.js 16 frontend. Read [the root guide](../../AGENTS.md) first for workspace-wide
commands and conventions.

## Commands

The root scripts apply with `--filter=@repo/web`; `typecheck` needs a prior `build` for
`.next/types`. This package's own:

```bash
pnpm --filter=@repo/web test:watch
pnpm --filter=@repo/web test:e2e     # Playwright — see Tests
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
    profile/      The account, with edit/ under it (see The profile)
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
- **`globals.css` overrides HeroUI's light `--muted`, and that override is a fix, not a taste.**
  The shipped value is 4.43:1 against `--background` in light mode — under the 4.5:1 WCAG AA
  needs for normal-size text. It passes on a card (4.83:1), so the failure only shows where
  secondary text sits straight on the page: the greeting's email address, the "Back to your
  meetings" links, every spinner caption. Darkening to `oklch(53% …)` puts those at 4.86:1 and
  the card at 5.30:1. It is scoped `:root:not([data-theme='dark'])` because the rule follows
  the import — a bare `:root` at equal specificity would beat HeroUI's dark block as well and
  paint light-theme grey onto a dark page. Dark's own `--muted` is 7.72:1 and is left alone.
  Measure before changing either: the numbers above are from a real browser, and HeroUI
  bumping its palette is what would silently undo this.
- **`globals.css` also gives dark-mode form fields their edge back and their hover state, and
  the two values are one decision.** HeroUI paints a field the same colour as the card in _both_
  themes — white on white in light, `oklch(21.03%)` on itself in dark — with `--field-border`
  transparent at zero width throughout. Light mode separates the two with `--field-shadow`, a
  real drop shadow; dark mode sets that to `0 0 0 0 transparent inset`, because a black shadow
  on a near-black card shows nothing, and puts nothing in its place. The result is an input with
  no boundary at all until it is focused, on every form in the app. The override is the
  dark-mode equivalent of that drop shadow: a 1px **inset** hairline, so it costs no geometry
  and the field is the same size in both themes, landing in the shadow slot after Tailwind's
  four so `ring-*` and HeroUI's own `status-focused-field` keep theirs — which is what
  upstream's "transparent shadow to allow ring utilities to work" is protecting.
  **`--field-hover` is overridden in the same block and cannot be separated from it.** The hover
  rule changes `background-color` and `border-color`, and the border has no width, so the
  background is hover's only lever in this theme — and every step it takes eats the hairline's
  contrast. Shipped, hover is a two-point step (rgb(26, 26, 29) on rgb(24, 24, 27)), which is no
  state at all; opening it to one that reads costs the line enough that the line has to come up
  with it. **Both are measured, not picked.** WCAG 1.4.11 wants 3:1 for whatever identifies a
  control, and that covers its _states_, so the line clears the bar over the hover background
  too. Nothing in the dark palette reaches even the resting bar (`--border` is 1.21:1,
  `--segment` 1.89:1), so the line is lighter than either: `oklch(56% …)` measures 3.81:1 on the
  card and at focus, 4.35:1 on the page, and **3.20:1 over hover, which is the number that set
  it**. Raise the hover step and you must re-measure the line. Two tokens, so every component
  drawing `bg-field`+`shadow-field` inherits both — input, input group, textarea, select,
  checkbox, radio, autocomplete, number field, search field, date input, OTP — and
  `--field-hover` is only ever read inside a `:hover` block, so it changes nothing at rest. Do
  not reach for a per-form class instead.
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
- **Retry on a failed row is gated exactly like Delete.** `FileRow` takes one `canManage` flag —
  uploader or host — because the API applies one rule to both and two flags could only disagree
  with it. The retry needs no local state machine: the API answers with the file as `uploaded`,
  and the list already polls while anything is. A 409 means someone else got there first, so the
  list is refetched rather than second-guessed; anything else shows inline with Dismiss.
- **A file over 100 MB is uploaded in chunks, and the row is the only part that looks
  different.** `use-upload-queue.ts` routes on `isChunkedUpload`; `FilesSection` only learns
  that such a row carries a session id (Cancel drops it server-side, Retry resumes).
  The client-side size check is the **chunked** cap for that reason — rejecting at 100 MB would
  refuse a file the app can perfectly well send.
- **A stored upload session id is a hint, never a promise.** A browser cannot keep a `File`
  handle across a reload, so `src/lib/upload-sessions.ts` keys the session id by
  `<name>:<size>:<lastModified>` and the re-picked file is matched to it. `uploadInChunks` asks
  the server and opens a new session when the stored one has expired or describes a different
  file, which is what makes a stale entry harmless and why nothing expires entries here.
- **The upload queue renders on `uploads.length`, not on the list being `ready`.** Add file and
  the drop target work while the list is still loading or failed, so hiding the queue there would
  swallow a rejection message and run an upload with no progress or Cancel. The queue itself is
  `use-upload-queue.ts` — one upload in flight at a time, the client-side checks on the way in —
  and the drag state is `use-drop-target.ts`, whose depth counter is what keeps the target lit
  while the pointer crosses the rows inside it. Pre-flight messages
  come from the `MEETING_FILE_*_MESSAGE` constants in `@repo/shared` — the same ones the API
  sends — so a file rejected here reads exactly as it would have from the server. Queue rows are
  keyed by a counter, not `crypto.randomUUID()`, which exists only in secure contexts: a dev
  server opened over plain HTTP from a phone is not one.

### The files stream

The meeting page follows its files over SSE: `useMeetingFiles` opens
`GET /meetings/:id/files/events` at mount beside the first list fetch, and `applyFileEvent`
replaces a known id **where it is**, re-sorts an unknown one in, and removes a `deleted` one,
so the Processing chip goes the moment the worker finishes. Four rules, each of which was a
bug once:

- **The list is refetched every time a stream opens, and events arriving during a fetch are
  replayed on top of the snapshot.** An event says what a row is now; a list says what every
  row was when the server ran the query; the client cannot order the two. Only a list
  requested after the server subscribed this connection holds what no event will repeat, and
  the replay is what stops a slow refetch putting a settled row back to Processing.
- **`EventSource` is not used, and cannot be while the token is in `localStorage`**: it sends
  no `Authorization` header, and a token in the URL is logged by every proxy. The stream is
  opened with `fetch` and parsed by `src/lib/sse.ts` — a file the cookie migration deletes.
- **The three second poll is the fallback and must not be deleted.** `watchMeetingFiles`
  reopens a dropped stream (1, 2, 4 seconds; a TTL close is an ordinary drop). After three
  drops in a minute the poll takes over **for a minute (`STREAM_RETRY_MS`), not for good** —
  an API restart is exactly three drops, and a page that never retried would sit on the poll
  until reloaded. A stream is the first thing a corporate proxy or captive portal breaks.
- **One polite `role="status"` region** (`FilesSection`, visually hidden) announces how many
  files are processing: one per section, never one per row, and empty on first render so
  nothing is read aloud for arriving.

## API access

All calls to the backend go through `src/lib/api-client/` — the single boundary between the
web app and the API, imported as `@/lib/api-client` whichever file inside it a wrapper lives
in. `core.ts` holds the transport every wrapper shares (`apiFetch`, `ApiError`, the bearer
header, `sendWithProgress`); `auth.ts`, `user.ts`, `meetings.ts`, `meeting-files.ts` and
`uploads.ts` group the wrappers by the part of the API they call, and `index.ts` re-exports
all of them. `auth.ts` and `user.ts` split where the API splits — credentials and tokens
against the account record — which is why `getMe` sits in `auth.ts` under `/auth/me` while
`updateDisplayName` sits in `user.ts` under `/users/me`.
**Only `index.ts` is imported from outside** — a component reaching for `api-client/core`
has stepped around the boundary. Add endpoint wrappers to the matching file (`apiFetch<T>`
plus a named function, then one line in `index.ts`) rather than calling `fetch` from
components. The base URL comes from `NEXT_PUBLIC_API_URL`, defaulting
to `http://localhost:3001/api` (origin _and_ the API's `/api` prefix); response shapes are
imported as types from `@repo/shared`.

Failures throw `ApiError`, carrying the HTTP status **and the API's own message** — read out
of the `ApiErrorResponse` body, joining the one-per-rule array a validation failure returns.
That is what makes `error.message` safe to render: "That email is already registered" is not
recoverable from a 409. Reading the body must never throw, because a failing response is not
obliged to carry JSON and a parse error would replace the real failure. A rejection that is not
an `ApiError` means the request never reached the API.

Three calls are exceptions, and all three stay inside that directory:

- **`uploadMeetingFile` and `putChunk` are `XMLHttpRequest`**, because `fetch` cannot report
  upload progress and the PRD asks for a percentage. Both go through one shared
  `sendWithProgress` in `core.ts`, so the exception lives in a single place; everything else
  about them matches `apiFetch`. A third caller belongs there too — nothing else in the app
  may open an `XMLHttpRequest`.
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

Nothing here may treat 3001 as fixed or discover the API's port at runtime — Next inlines
`NEXT_PUBLIC_API_URL` at boot; see
[the root guide](../../AGENTS.md#pnpm-dev-picks-the-ports-before-turborepo-starts).

### Client-side validation and credentials

`src/lib/credentials.ts` mirrors the API's registration rules, using the bounds exported by
`@repo/shared` rather than its own copies. Being **stricter than the server is the failure that
matters** — it rejects a value the API would have accepted and gives the user no appeal — so
the email pattern is deliberately looser than the API's `@IsEmail()`.

Where a rule is more than a bound — how a length is _counted_ — the function itself lives in
`@repo/shared` and both sides call it. `validateDisplayName` is `isDisplayNameWithinBounds`,
which counts code points; a `.length` here would count an emoji twice and refuse names the
API accepts.

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
this module and `use-signed-in.ts` below are deleted rather than extended — do not build more
session machinery on either. Every access is guarded (`localStorage` throws outright where
storage is disabled) and nothing rethrows, because losing a token is survivable and failing a
completed registration over it is not.

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
No provider, no context, no refresh, no interceptor. A page adds only its own requests and
hands a mid-page 401 back to `signOut`.

**Signing out is local**: clear the token, `replace` to `/auth/login`. There is no logout
endpoint because the JWT is stateless and stays valid until it expires. That is a property of
bearer tokens, not a gap to fill.

### The profile

Two routes, `/profile` to read the account and `/profile/edit` to change it, both gated like
every other protected page and both adding **no request of their own** — `getMe` inside the
gate is the whole of what they render.

**Everything the user can change goes in a section on `/profile/edit`, not in a route of its
own.** The page owns the gate; each section owns its request and its own state. That is why
the display name's save state lives inside `DisplayNameSection` rather than on the page, and
why `ChangePasswordSection` beside it holds no user at all. The three sections are picture, name, then
password: the picture first because it is the one result the reader can see, the password last
because a form that can lock someone out does not belong at the top of a page.

**A 401 from `PATCH /auth/password` does not always mean "signed out", and that is the one
trap on this page.** The API answers a wrong current password with 401 — login's shape, so
the endpoint reveals no more than login does — and the gate reads every other 401 as an
expired token. The two are told apart by `CURRENT_PASSWORD_MESSAGE`, which both sides import
from `@repo/shared` precisely so neither spells the sentence out. `isExpiredToken` in
`change-password-failure.ts` is the whole of that decision, and getting it backwards signs a
user out of the app because they mistyped one field. A Playwright test asserts they stay on
the page.

**The current-password field validates with `validateLoginPassword`, not `validatePassword`.**
It holds whatever was accepted when the account was made; applying today's minimum to it would
refuse an old password on the very form that exists to replace it. The new-password field gets
the registration rule plus "not the one you have now", and the confirmation is checked in the
browser and **never sent** — the API has nothing to compare it against that the form did not
already have.

**A save replaces the gate's user through `updateUser`.** `PATCH /users/me` answers with the
whole updated record, so the page that saved puts it straight back into the hook instead of
refetching. The hook is not a shared store — every page mounts its own copy — and nothing
about that needs fixing: a page navigated to afterwards loads the user for itself.

**`UserAvatar` is the circle, and `UserInitials` is its fallback.** Pages draw `UserAvatar`,
which is the only thing that imports `UserInitials`. It exists rather than a
`<span>` per page so the header and the profile cannot disagree about what a person looks like.
Two things in `initialsOf` look like fussiness and are not: characters come out with
`Array.from` because a letter outside the BMP is two code units, and each initial is uppercased
**separately** because uppercasing can lengthen (`'ß'` becomes `'SS'`), which would put three
glyphs in a circle sized for two. A name with nothing renderable in it falls back to `?`.

**The picture is fetched, never pointed at, and `avatarVersion` is what makes a new one
appear.** An `<img src>` cannot carry the bearer header the avatar route requires, so the bytes
come back as a blob — the same shape the meeting-file thumbnail uses, and one more thing the
`HttpOnly` cookie migration would delete. The API's avatar path is the _same string_ for every
picture an account will ever have, so the fetch is keyed on `avatarVersion` instead; a fetch
keyed on the path would keep drawing the picture that was replaced.

**`UserAvatar` revokes its object URL in a second effect, and that is load-bearing.** React runs
that cleanup only after the DOM already holds the next URL, so the browser never has an `<img>`
pointing at a freed blob. Revoking inside the fetch effect — the obvious single-effect version,
and what `file-row.tsx`'s thumbnail does — releases the picture on screen the moment a
replacement starts loading, and the user watches a broken image until it arrives. A unit test
pins the ordering.

**A `FormData` body is the one case `apiFetch` does not label.** It leaves the `content-type` to
the browser, which is the only thing that can produce the multipart boundary; declaring it would
send a boundary-less header the server cannot parse, and the failure reads as a broken upload
rather than a wrong header.

## Tests

Vitest with the jsdom environment, files matching `src/**/*.test.{ts,tsx}` next to the code
they cover. Not Jest — that's the API app.

**Component render tests exist, and they are the exception rather than the default.** Logic
worth pinning still belongs in `src/lib`, where a test needs no DOM at all; reach for a render
test when what you are checking _is_ the rendering — which branch of a gate is on screen, that
a form refuses a value without sending a request, where a failure is shown.

`@testing-library/react` and `@testing-library/user-event` are the whole of the setup. There is
no `setupFiles` and no jest-dom: `globals` is off in `vitest.config.ts`, so each file calls
`cleanup()` in its own `afterEach`, and `getBy*` throwing when an element is absent is
assertion enough without extra matchers.

**Mock the gate, not the token under it.** `vi.mock('@/lib/use-signed-in')` and hand the page
each `SignedIn` state directly. The states are the contract the pages are written against, and
`signedOut` in particular is only reachable that way — it is the window in which the page is
still mounted while Next navigates away, which is exactly where you want to assert nothing
about the account is on screen. Mock `api-client` **partially**, with `importOriginal`: pages
tell a 400 from a 401 with `instanceof ApiError`, and a replaced constructor sends every
branch to the network case and passes for the wrong reason.

The browser suite below is still the stronger check, and the one a flow belongs in.

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

**Every wait in the suite goes through `e2e/timeouts.ts`, and `E2E_TIMEOUT_SCALE` is the dial
for a busy machine.** Most specs wait on one chain — upload lands, the worker claims the row
on its next 250 ms poll, a step runs, the transition commits, an event is published, the page
renders it. Instrumenting the API during failing runs showed that chain finishing in about a
second, with the worker never idle while a row was claimable and every transition published to
a subscriber, while the page's fifteen-second assertion still timed out. What differed was the
machine, not the code: the same suite passes in 47 seconds and fails two or three of those
waits in 1.4 minutes, and a failing spec passes alone every time. So `E2E_TIMEOUT_SCALE=2`
doubles every ceiling — the `expect` default, each explicit `timeout:`, and the server wait —
and costs nothing when the page is quick, because they are ceilings and not sleeps. **Raise it
to get a signal out of a loaded machine, never to quiet a red suite**: a wait that only passes
at a high scale has found something. Add a new wait through `scaled()` rather than a literal,
or it will be the one that cannot be stretched with the others.

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
exclusively through `src/lib/api-client/` (the API access section is then wrong and needs
rewriting rather than amending), or when the path alias, test runner, or test file pattern
changes. Adding an ordinary component, route, or endpoint wrapper that follows the existing
patterns needs no update.
