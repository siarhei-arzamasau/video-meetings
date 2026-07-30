import type { ReactNode } from 'react';

import { ThemeToggle } from '@/components/theme-toggle';
import { Wordmark } from '@/components/wordmark';

/**
 * The two-column shell both auth pages sit in. A layout rather than a piece each page
 * repeats: the panel is identical on either side, and Next keeps it mounted across the
 * sign-in ⇄ sign-up link, so following that link swaps only the card.
 *
 * A Server Component. Only the cards need interactivity, so only they are client boundaries
 * and none of this ships as JavaScript.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="grid min-h-dvh lg:grid-cols-[1.05fr_1fr]">
      <BrandPanel />

      {/* `min-w-0` is load-bearing. A grid item defaults to `min-width: auto`, so this column
          refuses to shrink below the card's min-content width and the whole page scrolls
          sideways on a narrow phone — measured at 389px against a 375px viewport. */}
      <section className="relative flex min-w-0 items-center justify-center px-6 py-12 sm:px-10">
        <div className="absolute top-6 right-6">
          <ThemeToggle />
        </div>

        <div className="w-full max-w-md">
          <div className="mb-8 flex justify-center lg:hidden">
            <Wordmark />
          </div>

          {children}
        </div>
      </section>
    </main>
  );
}

/**
 * The decorative half. Its gradient is fixed rather than themed — the panel supplies its own
 * dark background in both light and dark mode, so the white text on it is legible either way
 * without a second colour scheme to maintain.
 */
function BrandPanel() {
  return (
    <aside className="relative hidden overflow-hidden bg-linear-160 from-[oklch(0.64_0.19_256)] via-[oklch(0.45_0.17_272)] to-[oklch(0.24_0.08_280)] p-12 text-white lg:flex lg:flex-col lg:justify-between">
      {/* Two soft lights, drawn behind the content, to keep the flat gradient from reading
          as a solid block. `aria-hidden` because they say nothing. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-32 -right-24 size-96 rounded-full bg-white/20 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-40 -left-20 size-96 rounded-full bg-[oklch(0.7_0.18_200)]/25 blur-3xl"
      />

      <div className="relative">
        <Wordmark isOnDark />
      </div>

      <div className="relative flex max-w-lg flex-col gap-8">
        <div className="flex flex-col gap-4">
          <h1 className="text-4xl leading-tight font-semibold tracking-tight text-balance">
            Meetings that start the moment you do.
          </h1>
          <p className="text-lg text-white/70 text-pretty">
            Create a room, share one link, and everyone is in — from a browser, on any device.
          </p>
        </div>

        <ul className="flex flex-col gap-4">
          <Highlight title="One link, nothing to install">
            Guests join straight from the browser, host or not.
          </Highlight>
          <Highlight title="Scheduled or right now">
            Book a slot ahead, or open a room and send the link.
          </Highlight>
          <Highlight title="You decide who is in the room">
            Meetings are yours; participants are invited, never discovered.
          </Highlight>
        </ul>
      </div>

      {/* The panel deliberately carries no sign-in/sign-up link. It is hidden below `lg`,
          so a cross-link here would be missing on exactly the viewports that most need it;
          each card carries its own instead. */}
      <p className="relative text-sm text-white/50">
        Your meetings, your guest list. Nothing joins a room uninvited.
      </p>
    </aside>
  );
}

function Highlight({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-white/15">
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          className="size-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m5 12.5 4.5 4.5L19 7.5" />
        </svg>
      </span>
      <span className="flex flex-col gap-0.5">
        <span className="font-medium">{title}</span>
        <span className="text-sm text-white/60">{children}</span>
      </span>
    </li>
  );
}
