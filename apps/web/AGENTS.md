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
    meetings/[id] The meeting page; files/ under it is the files section, digest/ the digest
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
- **Error text is `text-danger-soft-foreground`, never `text-danger`.** `--danger` is a fill:
  the colour of a danger button, chosen to sit under `--danger-foreground`, and as 14px text
  it measures 3.57:1 on a card in the light theme and 3.97:1 in the dark — under the 4.5:1
  WCAG AA needs. `--danger-soft-foreground` is the token HeroUI itself writes danger text in
  (its soft chips and alerts): the same red mixed towards `--foreground`, 6.74:1 on a light
  card and 6.30:1 on a dark one, measured in Chromium. Every inline `role="alert"` on the
  meeting page uses it — a row's download, retry and transcript errors, an upload that failed,
  the digest's retry. It is a class at each call site rather than an override of
  `--danger` in `globals.css`, because darkening the token would darken every danger button
  with it.
  **HeroUI's own form text gets the same colour from `globals.css`, not from a class**: a
  field's error message (12px), the label of an invalid field, and a required field's
  asterisk are all written in `--danger` by HeroUI's stylesheet, where no call site can
  reach. The rule there redefines `--danger` as `--danger-soft-foreground` inside `.label`
  and `.field-error` only — two components that draw nothing but text — which reaches all
  three whatever selector paints them, and leaves every danger button and the token itself
  alone. Measured on the sign-in and registration forms: 6.70:1 on a light card, 6.30:1 on
  a dark one. **A HeroUI component adopted later that writes text in `--danger`** — a
  danger menu or list-box item does — **is added to that rule**, after measuring it.
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
- **A link drawn as a button is `ButtonLink` (`src/components/button-link.tsx`), never
  `buttonVariants` on a `Link`.** HeroUI 3.2.2 attaches a button's focus ring to
  `:focus-visible:not(:focus)`, which nothing can match, and to `data-focus-visible`, which
  only React Aria sets — so an anchor wearing the variant classes has the button's
  `outline-none` and no ring, and tabbing to it shows nothing at all. The component adds
  `focus-visible:focus-ring`, the utility the button's own rule applies, so the two rings
  cannot drift. Upstream fixed the selector in 3.2.5; that upgrade moves React Aria to peer
  dependencies, which is why it was not the fix. Delete the constant with it.
- **A `Spinner` inside a `Button` is `color="current"`.** Its default is the accent, which is
  the fill of a primary button: on "Signing you in…" and every other submit it was drawn in
  the colour it sat on. A spinner in a chip or beside a caption stays the accent.
- **The sign-in and sign-up cards name the page, so their `Card.Title` is the `h1`**
  (`renderPageHeading`, `src/app/auth/page-heading.tsx`). HeroUI's own is an `h3`; the brand
  panel's tagline used to be the only `h1`, and that panel is hidden below `lg`. The tagline
  is a paragraph now, so there is one `h1` at every width.
- **The dashboard offers no "New meeting", on purpose, until there is a page to create one
  on.** Both of its links pointed at `/meetings/new`, which no route answers — the meeting
  page took `new` for an id and showed "Page not found". The action returns with the page;
  `ready-dashboard.test.tsx` holds the dashboard to linking only where a page exists.
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
  only job is to redirect. Its `headers()` puts a Content-Security-Policy and the framing,
  sniffing and referrer headers on every route. **`script-src` keeps `'unsafe-inline'` on
  purpose**: the App Router streams its payload in inline scripts and next-themes sets the theme
  in one, and nonces would take a proxy that makes every page dynamic. The policy earns its keep
  in `connect-src` and `img-src`, which name only this origin, the API (`NEXT_PUBLIC_API_URL`,
  read when the config loads) and the app's own blob URLs — a script that got in could not send
  the `localStorage` token anywhere. **A new outside origin — fonts, analytics, a CDN — must be
  added there, or the browser blocks it.**
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
  `pnpm --filter=@repo/web run clean` (it is `rm -rf .next`). **`run` is not optional**: pnpm 11
  has a `clean` command of its own, and with a filter the bare `pnpm --filter=@repo/web clean`
  is that command — it prints `Unknown option: 'recursive'` and removes nothing, so the cache
  is still corrupt when you start `next dev` again. Nothing in the app causes it or can
  prevent it; do not go looking there first.
- **An authenticated image needs an object URL.** The token is in `localStorage`, so an
  `<img src="/api/…/thumbnail">` would arrive with no credentials and a 401. `Thumbnail`
  (`files/thumbnail.tsx`) fetches it with the bearer header, turns the blob into
  `URL.createObjectURL`, and revokes it on unmount. Downloads and transcripts work the same
  way. All three collapse into plain URLs once the token is an `HttpOnly` cookie.
- **A row has one Retry, for whichever of the two failed, and it is gated exactly like Delete.**
  `FileRow` takes one `canManage` flag — uploader or host — because the API applies one rule to
  Delete, to the file's retry, and to the transcription's, and a second flag could only disagree
  with it. Which retry the button sends is `retryTargetOf` (`src/lib/meeting-file-retry.ts`):
  the file, back through the pipeline, or only a ready recording's transcription, back to the
  queue. **Never both** — a file that failed its checks was never queued for transcription, so
  the API writes no row that is both, and the file is asked about first so the page could not
  draw two buttons of one name even if one arrived. **A transcription that outran the time
  limit gets no Retry at all**: the API refuses it, its reason says a retry would end the same
  way, and `retryTargetOf` asks `@repo/shared` whether the reason is that one rather than
  reading the sentence itself. `useRetry` is the one set of outcomes the
  two share, and it needs no local state machine. **The API's answer is never put on the row:
  a 200 refetches the list, exactly as a 409 does.** The answer is the file as the retry left
  it — `uploaded`, or `ready` with its transcription `queued` — and written over the row it
  can be the oldest thing on the page; the files stream section below has why. The refetch is
  also what starts the fallback poll, which runs for exactly those two states, when there is
  no stream — and a refetch that fails is asked for again by that poll, so a lost one cannot
  leave a retried row reading "failed". A 409 means someone else got there first, so the list
  is asked rather than second-guessed; anything else shows inline with Dismiss. A second hook
  for the transcription's retry would be a second copy of those answers, free to drift from
  the first.
- **A recording's transcription is a second status on the row, beside the file's own and never
  instead of it.** `transcriptionPresentation` sits next to `statusPresentation` in
  `src/lib/meeting-files.ts` and `TranscriptionStatus` draws it in the same slot, in the row's
  own idiom: a chip for "Queued for transcription" and "Transcribing…", an "Open transcript"
  link, and a warning chip for "Transcription failed" — the Retry that goes with it is the
  row's own, in the entry above, not a control of this element. **Neither failure chip has a
  tooltip — this one or the file's own "Processing failed": the row writes each reason under
  the file's name.** A tooltip opens on hover or keyboard focus and a touch screen has
  neither, and for the failure with no Retry the reason is the only thing on the row that
  says what would help. So a chip is not a tab stop either; the row's first one is Retry.
  A file with no `transcriptionStatus` draws nothing, and that one rule is all of "a PDF shows
  no status" and "a deployment with transcription off shows none". Nothing about Download reads
  it: a recording is `ready` before its transcription starts and stays `ready` if it fails.
- **"Open transcript" is a link with no `href`, and its tab is opened before the text is
  fetched.** The transcript route needs the bearer header, so the text comes back through
  `fetchTranscript` and is shown from an object URL. `useTranscript`'s `open` calls
  `window.open` first, **synchronously inside the press**, and points that tab at the blob
  when it arrives — a tab opened after an `await` is a popup, and browsers block those without
  saying so. Call `open` from the press handler and nowhere else. Three things around it look
  optional and are not:
  - **`fetchTranscript` retypes the blob to `text/plain` whatever the response claimed.** An
    object URL is a document on this origin, and the policy in `next.config.ts` allows inline
    script, so a body opened as `text/html` would run beside the token in `localStorage`. The
    text is another service's output; the type it is shown under is this app's.
  - **The object URL is revoked when the row unmounts, not on the next tick** as the
    download's is. A tab cannot be reloaded from a revoked URL, and a row that has gone is a
    recording that was deleted. **A row makes one and reuses it**: a stored transcript never
    changes, so a later press points its tab at the first answer rather than fetching the
    text again and holding a second copy of it.
  - **`tab.opener` is set to `null`**, because `noopener` would return no window to point at
    the text.
- **A file over 100 MB is uploaded in chunks, and the row is the only part that looks
  different.** `use-upload-runner.ts` routes on `isChunkedUpload`; `FilesSection` only learns
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
  `use-upload-queue.ts` — the rows, the client-side checks on the way in — with the runner
  that sends them one at a time in `use-upload-runner.ts`,
  and the drag state is `use-drop-target.ts`, whose depth counter is what keeps the target lit
  while the pointer crosses the rows inside it. **Leaving the page ends every upload in flight
  and is not Cancel**: the queue aborts its requests when it unmounts — "Back to your
  meetings", Log out, a 401 — because an upload left running had no row and no Cancel, kept
  the token it started with, and was joined by a second runner on the same session once the
  file was picked again. A chunked upload's session is neither dropped on the server nor
  forgotten here, so picking the file again resumes it. Pre-flight messages
  come from the `MEETING_FILE_*_MESSAGE` constants in `@repo/shared` — the same ones the API
  sends — so a file rejected here reads exactly as it would have from the server. Queue rows are
  keyed by a counter, not `crypto.randomUUID()`, which exists only in secure contexts: a dev
  server opened over plain HTTP from a phone is not one.

### The files stream

The meeting page follows its files over SSE: `useMeetingFiles` opens
`GET /meetings/:id/files/events` at mount beside the first list fetch — **called by the page,
not by `FilesSection`**, which is handed the result, because the stream is the meeting's and
carries its digest too (_The digest_, below) — and `applyFileEvent`
replaces a known id **where it is**, re-sorts an unknown one in, and removes a `deleted` one,
so the Processing chip goes the moment the worker finishes. A transcription moving on is the
same event — the whole file, with a new `transcriptionStatus` — so the row follows it with no
code of its own. The hook is three composed, each the one place its concern lives:
`useFilesSnapshot` holds the list and puts a fetch and an event in order, `useFilesStream`
holds the connection and gives up on it, and `useFallbackPoll` runs when it has. Six rules,
each of which was a bug once:

- **The list is refetched every time a stream opens, and events arriving during a fetch are
  replayed on top of the snapshot.** An event says what a row is now; a list says what every
  row was when the server ran the query; the client cannot order the two. Only a list
  requested after the server subscribed this connection holds what no event will repeat, and
  the replay is what stops a slow refetch putting a settled row back to Processing.
- **A retry's answer is not an event, and `useMeetingFiles` has no way to write one over a
  row.** The retry routes answer with the file as the retry left it, on a connection of their
  own, while the stream reports that same state and everything after it on another — and with
  Whisper still down "everything after" is a claim and a second failure, a fraction of a
  second later. When the answer landed last the row went back to "Queued for transcription"
  with no Retry on it, and stayed there: no event follows a failure, and the poll does not
  run beside a stream. So `FilesSection` hands `refresh` to both of the row's outcomes. A list
  requested after the retry is covered by the rule above; a lone answer has nothing to be
  ordered by, because `MeetingFile` carries no version. `files-section.retry.test.tsx` pins
  the order that broke — events first, answer last — for both retries.
- **The upload's answer is the one answer the list still takes, and only as a row it does not
  have.** `add` never replaces: that answer is the file as it was created, the earliest state
  it will ever have, so a row the stream has already delivered is as new or newer. Written
  over it, a file the worker had finished went back to Processing — and for a PDF, which
  nothing more happens to, stayed there. `use-meeting-files.add.test.ts` pins that order.
- **`EventSource` is not used, and cannot be while the token is in `localStorage`**: it sends
  no `Authorization` header, and a token in the URL is logged by every proxy. The stream is
  opened with `fetch` and parsed by `src/lib/sse.ts` — a file the cookie migration deletes.
- **The three second poll is the fallback and must not be deleted.** `watchMeetingFiles`
  reopens a dropped stream (1, 2, 4 seconds; a TTL close is an ordinary drop). After three
  drops in a minute the poll takes over **for a minute (`STREAM_RETRY_MS`), not for good** —
  an API restart is exactly three drops, and a page that never retried would sit on the poll
  until reloaded. A stream is the first thing a corporate proxy or captive portal breaks.
  **The poll runs while `isAwaitingWorker`, which is wider than `isProcessing`**: a file still
  being processed, or a recording whose transcription is queued or running. A recording is
  `ready` minutes before its transcript is, so gated on `isProcessing` a page without a stream
  would sit on "Transcribing…" until it was reloaded. `isProcessing` stays what the Processing
  chip and the announcement below count. **A poll that fails arms the next one**: the timer is
  re-armed by `settled`, the count of fetches that came back, not by the list. A failed fetch
  keeps the list it had — the same object — so a poll armed by the list stopped at its first
  failure, which is the API restarting: the one time the page has nothing but the poll.
  **So does any other refetch that fails while there is no stream** (`lastFetchFailed`), even
  over a list with nothing awaited in it. That list is the old one: after a Retry that was
  answered and a refetch that was lost, it still shows the failure, with a Retry the API
  would answer 409 — and nothing in it would ever arm the poll. It stops at the first fetch
  that lands, when the list can speak for itself again.
- **One polite `role="status"` region** (`FilesAnnouncement`, visually hidden) announces how
  many files are processing, and each transcription that ends: one per section, never one per
  row, and empty on first render so nothing is read aloud for arriving. `useFilesAnnouncement`
  derives both from the list, so the poll says what the stream would. **It is handed `null`
  until the list has loaded, never an empty array**: the page renders before its files
  arrive, and a placeholder taken for the opening list made the first real answer a change —
  "1 file is processing." read to someone who had only just opened the page. **A transcription is
  announced at its two ends only** — the transcript is ready, or it failed — and only for a
  row the page saw queued or running: the steps between are three interruptions where one
  says everything, and a recording that arrives finished is nobody's news. Changes that land
  in one render are joined into one phrase, since the region holds one string and a second
  write would replace the first before it was read. **A phrase worded like the last one is
  still said, because the region's node is keyed on the phrase's number, not left to its
  text.** A retry that fails again produces the same sentence twice running; as a bare string
  in state the second is a no-op, the DOM does not change, and a screen reader says nothing.

### The digest

The meeting's digest — a summary, action items, and decisions, written by Claude from the
transcripts of its recordings — is the second thing the meeting page follows without a
reload. `DigestSection` (`meetings/[id]/digest/`) draws it, with one control, beside a digest
that failed, for the two kinds of member who may ask for another try: "Retry". Nobody asks
for a digest that is simply not there yet — the API generates it when a recording is
transcribed, or the next time it starts. What its API promises is in
[the API guide](../api/AGENTS.md#meeting-digests-srcmodulesmeeting-digests); what a reader
of this side would get wrong:

- **One stream, two consumers, and the page holds it.** The API sends the digest on the files
  stream, under `event: digest`. `useMeetingUpdates` (`meetings/[id]/`) is the one call the
  page makes: `useMeetingDigest` holds the digest and no connection, and is handed to
  `useMeetingFiles` as the stream's second consumer — refetched at every open, as the list
  is, and given each `digest` event. **Do not open a second stream for it**: every open page
  would hold two long-lived connections of the six a browser allows one origin.
  `deliverStreamEvent` (`src/lib/meeting-stream-events.ts`) is where an event's name picks
  its consumer, and an event that fits neither — or whose payload its reader cannot make
  sense of — is passed over rather than thrown.
- **The higher version is kept, and that is the whole of how a fetch is put in order against
  an event** — `laterDigest` in `src/lib/meeting-digest.ts`. A digest carries a `version`
  the API moves with every change, which a file does not; so there is no replay buffer
  here, no hand-over, and a fetch still in flight when another is asked for is simply let go.
  **Of two with the same version, a fetch wins and an event does not.** Two changes reach the
  API's answer under an unchanged version — a linked owner's new display name, and an
  `availableAction` that left with a recording nothing reacted to the delete of — and
  nothing announces either, so only a fetch can bring them; an event of a version already
  held is the same digest announced twice. Collapse the two cases into one comparison and
  either a rename never shows, or a duplicate event costs a render.
- **A status and content are two things, drawn side by side** — `digestPresentation`, a pure
  function, decides what each combination shows. The status is where the latest generation
  stands; the content is what the last successful one stored. That is how an out-of-date
  digest stays readable beside "Generating digest…", and beside "Digest failed" when its
  replacement could not be made. **`ready` has no chip**: it is said by showing the digest.
- **No status and no content is no section** — not an empty card. A meeting with no
  transcribed recording, one whose recordings have no digest yet, a digest withdrawn with a
  recording, and a page the API has not answered yet all draw nothing.
  `digestPresentation` is what a digest says to anybody; `digestSectionView`
  (`src/lib/meeting-digest-action.ts`) adds what this reader may do, and is what the section
  draws. **A digest that is not there has no control, on purpose**: the API generates it
  with nobody asking, so a button here would be a second way to ask for what is already
  owed — and a paid one. The one thing a reader can ask for is another try at a digest that
  failed, and a failure is itself something to show. `DigestAnnouncement`, the section's
  polite status region, therefore sits **outside** the card: one of the things it says is
  that the digest was removed, which a region that went with the section could not. It
  announces the ends only — ready, updated, failed, removed — and never the page's opening
  state, the way the files' region does (`digestAnnouncement`).
- **Who is offered the control is decided in one place: `offeredDigestAction`**
  (`src/lib/meeting-digest-action.ts`), called by `useDigestAction` from `MeetingSections`
  — there rather than in the section because it reads both halves of the page. Three things
  must hold. The digest carries `availableAction`, which says a failed digest may be retried
  and says it to every reader alike. The reader is the host, or the uploader of a recording the
  page's own list shows as transcribed — the people the API would not answer 404. **And the
  list holds a transcribed recording at all, which binds the host too.** That third one
  looks like a restatement of the API's rule and is the repair of a gap in it: when the
  last transcribed recording of a meeting whose digest failed is deleted and nothing reacts
  to the delete, `availableAction` leaves the digest _without its version moving_, so a
  page that keeps the higher version goes on holding `retry`. The deleted recording leaves
  the list by the same stream. A list that is loading or failed offers nothing, rather than
  a control drawn on a guess.
- **The request's answer is put on the page, which is the opposite of the row's Retry, and
  the version is why.** A row refetches its list and never writes a retry's answer over
  itself, because a file has nothing to order that answer against the stream by. A digest
  does: `useMeetingDigest`'s `accept` takes the answer as a fetch is taken — kept unless
  something later is already held — so a request overtaken by a claim and a second failure
  leaves the failure and its Retry on the page, and one that was not shows "Digest queued"
  with no fetch at all. Without a stream that `queued` is also what arms the fallback poll.
  `meeting-sections.digest-request.test.tsx` pins the order that would break — events
  first, answer last. **A 409 is never shown**: it says only that there is nothing to ask
  for any more, so the digest is fetched again and the page shows that. Anything else is
  inline, with Dismiss, as a row's is. **An error is shown only beside the control that was pressed**: while that
  control is offered and the digest held is still the version it was pressed on. Kept any
  longer it comes back beside the next Retry, which nobody has pressed. `useDigestAction`
  works that out on every render rather than clearing the error when it sees the control
  go, because the page does not always see it go: a failure can land after the stream has
  already taken the control away — the request was taken and its answer lost on the way
  back — and one chunk of the stream can hold a request, a claim and a second failure,
  which is one render with a Retry on it before and after.
  `meeting-sections.digest-error.test.tsx` pins both orders.
- **A press moves focus to the section's heading before it sends anything.** The control
  is disabled while its request is on its way and gone once it is taken, and a button
  removed while it holds focus drops a keyboard reader at the top of the page. The heading
  is where the status they asked for appears; if the request fails instead, the control is
  the next tab stop. That is why the `h2` has `tabIndex={-1}` and a focus ring.
- **The control is `secondary`.** The page has its one primary action, "Add file", and a
  digest is a consequence of the files rather than the reason the page is open.
- **It is drawn under the files, on purpose.** It appears, grows from a chip to three lists,
  and disappears with no action from the reader, usually while they are in the files above
  it. Above the files it would push the list they are using down the page each time.
- **Every string of a digest is rendered as a text child, and that is the whole defence.**
  It is a model's writing about what somebody said in a recording. Nothing in
  `digest-content.tsx` may turn one into markup; a Vitest and a Playwright spec both put an
  `<img onerror>` through it. The same text gets `overflow-wrap: anywhere` — a transcript
  can hold a URL, a digest quotes it, and one unbroken token is wider than a phone — and an
  owner's chip is allowed to wrap, since a display name may be eighty characters.
- **An owner is one of three, told apart by more than a colour**: a member of the meeting
  (accent chip with the person glyph), a name as it was spoken (plain chip), or
  "Unassigned" (muted text). The API decides which; the page never matches a name itself.
- **The fallback poll has a second trigger, because a digest with no status gives a poll
  nothing to run on.** Without a stream, `useDigestFallbackPoll` asks again every three
  seconds while the digest is queued or generating, armed by `settled` exactly as the files'
  poll is. But what _starts_ a digest is a recording being transcribed, and what withdraws
  one is such a recording being deleted; so it also asks whenever the list's set of
  transcribed recordings changes. Drop that and a page that cannot hold a stream watches its
  recording reach "Open transcript" and never learns a digest was queued. **That trigger
  runs beside an open stream too, and there it is a safeguard rather than a duplicate.** The
  digest's own event is sent by the API's reaction to the change, and a reaction that fails
  is logged and sends nothing — while the file's `deleted` event has already reached the
  page. Gated on the stream, a digest built from a deleted recording stayed on screen until
  the stream next reconnected, minutes later; the API withholds it from the moment the
  delete commits, so one fetch takes it off. **That change is asked about twice — at once,
  and one interval later — and the second is not redundant.**
  The API answers a delete, and reports a transcript, before it has decided what either does
  to the digest, so the first answer can be the digest as it was: nothing queued, nothing to
  poll on, and the replacement then generated unseen. It is one more fetch and not a poll,
  because with the setting off the answer never changes.
- **A fetch that fails shows nothing, and is asked for again whether or not there is a
  stream.** There is no error state for the digest: nobody asked for it, and the files
  section beside it already says when the API cannot be reached. What was held stays, and
  the same hook retries until a fetch lands: after three seconds, then twice as long each
  time, up to a minute (`digestRetryDelayMs`) — an API that is restarting is caught up with
  at once, and one that stays down is not asked every three seconds by every open page.
  **A fetch the API refused is not retried at all**: a 403 or a 404 is its answer about this
  meeting, and `failedFetches` counts only what the next try might not get again — a request
  that never arrived, a server error, a 408 or a 429. The stream is no substitute
  for that, which is why this half is not gated on it as the poll is: an event says a digest
  _changed_, and a digest that is simply there never does — a page whose fetch was lost
  would show none until the stream next reconnected, minutes later.

## API access

All calls to the backend go through `src/lib/api-client/` — the single boundary between the
web app and the API, imported as `@/lib/api-client` whichever file inside it a wrapper lives
in. `core.ts` holds the transport every wrapper shares (`apiFetch`, `ApiError`, the bearer
header) and `progress-upload.ts` the one `XMLHttpRequest` path; `auth.ts`, `user.ts`,
`meetings.ts`, `meeting-files.ts`,
`meeting-digests.ts` and `uploads.ts` group the wrappers by the part of the API they call,
and `index.ts` re-exports all of them. `auth.ts` and `user.ts` split where the API splits — credentials and tokens
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
  `sendWithProgress` in `progress-upload.ts`, so the exception lives in a single place;
  everything else about them matches `apiFetch`. A third caller belongs there too — nothing
  else in the app may open an `XMLHttpRequest`. **It ends a request that has not moved for
  `UPLOAD_STALL_MS` (a minute) as a network failure.** A connection can go quiet without
  resetting, and an `XMLHttpRequest` then reports nothing: the row sat at its percentage for
  good, and the only way out was Cancel, which drops the session a chunked upload would have
  resumed. Rejected as the `TypeError` a failed request is, a stalled chunk is re-sent by
  `uploadInChunks` like any other dropped one; Cancel still rejects as an abort, which nothing
  retries.
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
hands a mid-page 401 back to `signOut`. **The token is handed out in `loading`, as soon as the
effect has read it**, so those requests go out beside `getMe` rather than a round trip behind
it; a page still renders none of their data until the gate is `ready`, and a bad token then
reaches `signOut` from both sides, which it survives — clearing and replacing twice is the
same as once.

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
and what the file row's `Thumbnail` does — releases the picture on screen the moment a
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
`playwright.config.ts` starts three servers itself — the API through its `start:e2e-web` script
on **3101** (worker on, fast poll, temp storage, transcription on, and an auth rate limit no
run can reach: every spec registers through the UI and several sign in again, well past a
deployment's ten a minute), this app on **3100**, and a fake Whisper on **3102** — with
`reuseExistingServer` off, one worker, and no retries. **That API is not `src/main.ts`**: it
is `apps/api/test/e2e-web/main.ts`, the same application with the meeting digest on and a
scripted Claude bound inside it, which also listens on loopback **3103** for a spec's orders
(below). It needs `docker compose up -d postgres`
and `pnpm exec playwright install chromium` once. `E2E_SERVER_TIMEOUT_MS`
raises the two-minute wait per server; a wait that times out even at several minutes is the
corrupt-cache symptom above, not a slow machine. **It runs on a database of its own** — the
one `DATABASE_URL` names with `_web_test` after it, which that API entry point creates and
migrates before it connects — and its `globalTeardown` truncates `users` there and refuses
any database not named `…_test`. The API's own e2e suite has another, `…_test`
([the API guide](../api/AGENTS.md#tests)), so neither empties the other's or a developer's.
`e2e/global-teardown.ts` restates the naming rule because it cannot import the API's; change
the two together. A running `next dev` from this directory also blocks it, because Next
locks `.next`.

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

**A spec does not wait for a state a worker ends within one poll.** After a Retry of a file
that is still broken, the Processing chip is on the page for less than the 250 ms the worker
polls at — for a few tens of milliseconds, when that poll happens to follow the retry closely
— while Playwright's looks at the page back off from 20 ms apart to 500. `toBeVisible()` on it
failed about one run in eight with the page entirely right, and no scale helps a state that
has already gone. Assert what caused it instead: `meeting-files-retry.spec.ts` waits for the
retry's own answer through `page.waitForResponse`, then for the API to list the state the
worker settled on, then for the page to show that.

**A spec says which row it means: `rowFor` for a file the meeting has, `uploadRowFor` for an
upload** (`e2e/file-rows.ts`). The Files list draws both, and for a moment after an upload
both are on the page under one name: the stream delivers the file while the request that
sent it is still unanswered, and the upload's row goes only with that answer. A locator by
name alone resolved to two elements for those milliseconds and strict mode failed whatever
was being asserted — about one run of the suite in four, on whichever spec looked at a row
straight after an upload. `rowFor` is the row that says who added the file, which only a
listed file's does. **It is still strict among files**: two listed rows of one name fail a
spec, as they should, and that is what a `.first()` would have hidden. Do not write another
locator by name in a spec.

**The Whisper the suite talks to is `e2e/fake-transcriber.mjs`, and a reply belongs to a
recording, not to "the next request".** It is an OpenAI-shaped endpoint in plain Node that a
spec tells to hold a recording's answer open, fail it, or answer it with a sentence, through
`transcriber` in `e2e/transcription.ts` — so the API's own adapter and worker are what run,
and no spec needs a model. The API uploads every recording as `recording.mp3`, so the name
cannot tell two apart: `recordingNamed` appends a marker to the fixture's bytes and the reply
is registered under it. That is what stops a reply being spent on a recording another test
left behind — the specs share one database and the worker takes the oldest. Two consequences
worth knowing before writing a spec: **the API transcribes one recording at a time**, so a
held one keeps every later one at "Queued" (the only way to see that state for longer than a
250 ms poll, and the reason each test resets the fake at both ends); and a recording nothing
was registered for is answered at once, which is why switching transcription on changed no
existing spec. **A reply can be registered again for the same recording**, and that is all
"Whisper came back" is: the retry spec tells the fake to fail a recording, then to hold or
answer it, and the next request for those bytes — the one Retry causes — gets the new reply.

**The Claude the suite talks to is inside the API, and a spec scripts it through the
transcript.** The Claude Agent SDK has no HTTP seam to stand a fake behind, so
`start:e2e-web` boots a test entry point that binds `ScriptedClaudeAgent` over
`ClaudeAgentService` — the prompt builder, the answer's guard, the owner match, and the worker
all still run, and no spec needs a token or the network. What a digest holds is decided by
directives in the recording's transcript, which a spec already sets through the fake
transcriber: `digestTranscript` in `e2e/digest.ts` writes them, and the table in
`apps/api/test/e2e-web/digest-script.ts` is what they mean. Directives are read from every
recording of the prompt, so the digest of two recordings holds what both asked for and the
one that follows a delete holds only what is left. What to know before writing a spec:

- **A recording nothing was scripted for still gets a digest** — a one-line summary and two
  empty lists — so every spec that transcribes a recording now has a Digest section on its
  page. Scope a locator to the files list or to `digestSection`, not to the page.
- **An absence is asserted on a page that has loaded** — `openMeetingPage`, which waits for
  the files and for the digest's answer. `goto` resolves before the page has asked the API
  for anything, and `toHaveCount(0)` straight after it is true of every page.
- **The API generates one digest at a time**, as it transcribes one recording at a time. The
  only way to see "Digest queued" for longer than a 250 ms poll is another meeting's
  generation held ahead of it, which is what `meeting-digest.spec.ts` does.
- **A hold is a key, held by the spec, and not a directive alone.** A transcript names a key
  (`holdKey`); the generation waits only while the spec is holding that key (`claude.hold`,
  `claude.release`) on the control port. That is the transcriber's rule for the
  transcriber's reason: a generation held by its transcript alone would outlive a test that
  failed half-way and stop every digest after it, so `claude.reset()` at both ends of each
  test releases every key, and a key nobody holds delays nothing. A key can be written into
  a transcript long before it is held — that is how a spec holds the digest that _follows_
  a delete rather than the one before it.
- **A failure that ends is a key as well** (`failsWhile`): the generation fails while the
  spec holds the key and is answered once it lets go, so the Retry a spec then presses sends
  the same transcripts and ends in a digest. `fails: true` is the failure nothing gets past.
- **The setting is switched on the same port, because a spec cannot restart the API.**
  `claude.setting('off')` is `MEETING_DIGEST_ENABLED=false` in the running process: a
  recording transcribed then asks for no digest, which is the only way to reach a meeting
  that is owed one. **Nothing tells an open page the setting changed** — in a
  deployment it is a restart, which ends every stream — so a spec opens its pages after
  switching. `claude.reset()` switches it back on as well as releasing every key, for the
  reason it releases them: a test that failed with it off would otherwise leave the API
  generating nothing for every spec after it.
- **Switching it back on is not the restart, so the catch-up is asked for by name.** In a
  deployment the setting returns with a boot, and the boot asks for every digest a meeting
  is owed. `claude.catchUp()` runs that in the API the suite started, and resolves once
  each has been asked for. It is not tied to `setting('on')` because `reset()` calls that
  around every test, over a database the specs share: it would generate, before each
  test, for whatever every earlier one left owed. For the same reason a `catchUp()` also
  asks for what other tests left; those are answered at once, ahead of the spec's own.

The house convention it sets: **a new page starts as a red Playwright spec**, written against
the routes, copy, and roles the page will have, run and seen failing, then made green by the
implementation. The specs here were written that way.

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
