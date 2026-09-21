'use client';

import { Alert, Button, Spinner } from '@heroui/react';
import type { Meeting, User } from '@repo/shared';
import Link from 'next/link';

import { SignOutIcon, WarningIcon } from '@/components/icons';
import { ThemeToggle } from '@/components/theme-toggle';
import { UserAvatar } from '@/components/user-avatar';
import { Wordmark } from '@/components/wordmark';
import { useSignedIn } from '@/lib/use-signed-in';

import { DashboardLoadingShell } from './dashboard-loading-shell';
import { ReadyDashboard } from './ready-dashboard';
import { useDashboardMeetings } from './use-dashboard-meetings';

/**
 * The meetings list, once the gate has a user. `ready` with an empty list is not its own
 * variant: nothing about the data flow differs, and a variant restating a derivable fact is a
 * second source of truth for it.
 */
type Dashboard =
  | { state: 'loading' }
  | { state: 'ready'; user: User; latest: ReadonlyArray<Meeting>; total: number }
  | { state: 'failed'; message: string; retry(): void }
  | { state: 'signedOut' };

export function HomeDashboard() {
  // The gate — token read, `getMe`, 401 redirect — lives in the hook the meeting page shares.
  // What this page adds is its own two requests, in `useDashboardMeetings`.
  const { session, signOut } = useSignedIn();
  const token = session.state === 'ready' ? session.token : null;
  const { meetings, retry } = useDashboardMeetings(token, signOut);

  // One `loading` on screen for both the gate and the list: they differ in control flow, not
  // in what the reader sees, and starting there keeps the first render identical on the server.
  const dashboard: Dashboard =
    session.state === 'signedOut'
      ? { state: 'signedOut' }
      : session.state === 'failed'
        ? { state: 'failed', message: session.message, retry: session.retry }
        : session.state === 'loading' || meetings.state === 'loading'
          ? { state: 'loading' }
          : meetings.state === 'failed'
            ? { state: 'failed', message: meetings.message, retry }
            : {
                state: 'ready',
                user: session.user,
                latest: meetings.latest,
                total: meetings.total,
              };

  if (dashboard.state === 'signedOut') {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-3 p-6">
        <Spinner size="sm" />
        <p className="text-muted text-sm">Taking you to sign in…</p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-8 px-6 py-10">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <Wordmark />
        {/* `flex-wrap` and `justify-end`: this row grew a third control, and on a 375 px screen
            the three of them are wider than the viewport — without wrapping, Log out goes off
            the right edge and the page scrolls sideways. */}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {/* Only once the gate knows who this is: the link's whole content is the user, and a
              placeholder for it would be a second loading treatment for the same fact. */}
          {session.state === 'ready' && (
            <Link
              href="/profile"
              className="text-muted hover:text-foreground hover:bg-surface-secondary focus-visible:ring-focus flex items-center gap-2 rounded-full p-1 transition-colors outline-none focus-visible:ring-2 sm:pr-3"
            >
              <UserAvatar token={session.token} user={session.user} />
              {/* The visible text is the name, so the accessible name has to contain it —
                  `aria-label="Your profile"` would replace it and break "label in name". It is
                  also what labels the link on a phone, where the name itself does not fit. */}
              <span className="sr-only">Your profile</span>
              {/* Truncated here, unlike on the profile: the header has a fixed budget, and
                  `title` keeps the whole name one hover away. The profile page wraps it
                  instead, which is where a reader goes to read it in full. */}
              <span
                className="hidden max-w-32 truncate text-sm font-medium sm:inline"
                title={session.user.displayName}
              >
                {session.user.displayName}
              </span>
            </Link>
          )}
          <ThemeToggle />
          <Button variant="secondary" isDisabled={dashboard.state === 'loading'} onPress={signOut}>
            <SignOutIcon />
            Log out
          </Button>
        </div>
      </header>

      {dashboard.state === 'loading' && <DashboardLoadingShell />}

      {dashboard.state === 'failed' && (
        <Alert status="danger" role="alert">
          <Alert.Indicator>
            <WarningIcon />
          </Alert.Indicator>
          <Alert.Content>
            <Alert.Title>We could not load your meetings</Alert.Title>
            <Alert.Description>{dashboard.message}</Alert.Description>
          </Alert.Content>
          <Button variant="secondary" onPress={dashboard.retry}>
            Try again
          </Button>
        </Alert>
      )}

      {dashboard.state === 'ready' && (
        <ReadyDashboard user={dashboard.user} meetings={dashboard.latest} total={dashboard.total} />
      )}
    </main>
  );
}
