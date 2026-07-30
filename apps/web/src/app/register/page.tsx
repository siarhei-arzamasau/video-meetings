import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { ThemeToggle } from '@/components/theme-toggle';

import { RegisterCard } from './register-card';

export const metadata: Metadata = {
  title: 'Create your account · Video Meetings',
  description: 'Sign up for Video Meetings with an email address and a password.',
};

// A Server Component: only the card needs interactivity, so only it is a client boundary. The
// panel beside it is static markup and never ships as JavaScript.
export default function RegisterPage() {
  return (
    <main className="grid min-h-dvh lg:grid-cols-[1.05fr_1fr]">
      <BrandPanel />

      <section className="relative flex items-center justify-center px-6 py-12 sm:px-10">
        <div className="absolute top-6 right-6">
          <ThemeToggle />
        </div>

        <div className="w-full max-w-md">
          <div className="mb-8 flex justify-center lg:hidden">
            <Wordmark />
          </div>

          <RegisterCard />
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

      <p className="relative text-sm text-white/50">
        Already have an account? Signing in lands in a later release.
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

function Wordmark({ isOnDark = false }: { isOnDark?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5 text-lg font-semibold tracking-tight">
      <span
        className={`flex size-9 items-center justify-center rounded-xl ${
          isOnDark ? 'bg-white/15 text-white' : 'bg-accent text-accent-foreground'
        }`}
      >
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          className="size-5"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="2.5" y="6" width="12" height="12" rx="3" />
          <path d="m15.5 13 4.2 2.8a1 1 0 0 0 1.55-.83V9.03a1 1 0 0 0-1.55-.83L15.5 11Z" />
        </svg>
      </span>
      Video Meetings
    </span>
  );
}
