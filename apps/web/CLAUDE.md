# CLAUDE.md — `@repo/web`

The Next.js 16 frontend. Read the root [`CLAUDE.md`](../../CLAUDE.md) first for
workspace-wide commands and conventions.

## Stack

Next.js 16 (App Router) · React 19 · HeroUI 3 · Tailwind CSS 4 · next-themes · Vitest +
jsdom.

## Commands

```bash
pnpm --filter=@repo/web dev          # next dev on :3000
pnpm --filter=@repo/web build        # next build (standalone output)
pnpm --filter=@repo/web typecheck    # needs a prior build for .next/types
pnpm --filter=@repo/web test         # vitest run
pnpm --filter=@repo/web test:watch
```

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
  reaches workspace packages, and `transpilePackages: ['@repo/shared']`.

## API access

All calls to the backend go through `src/lib/api-client.ts` — it is the single boundary
between the web app and the API. Add new endpoint wrappers there (`apiFetch<T>` plus a
named function) rather than calling `fetch` from components. Failures throw `ApiError`
carrying the HTTP status.

The base URL comes from `NEXT_PUBLIC_API_URL`, defaulting to `http://localhost:3001/api`
(origin _and_ the API's `/api` global prefix). Response shapes are imported as types from
`@repo/shared`.

## Tests

Vitest with the jsdom environment, files matching `src/**/*.test.{ts,tsx}` next to the code
they cover. Not Jest — that's the API app.

## Keeping this file current

Update it in the same commit as the change. The root
[`CLAUDE.md`](../../CLAUDE.md#keeping-documentation-current) covers the general rules and
what belongs at the workspace level; this file owns what is specific to `@repo/web`.

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
