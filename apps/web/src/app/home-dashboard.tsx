'use client';

import {
  Alert,
  Button,
  Card,
  Chip,
  EmptyState,
  Separator,
  Skeleton,
  Spinner,
  buttonVariants,
} from '@heroui/react';
import type { Meeting, MeetingStatus, User } from '@repo/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { CalendarIcon, PlusIcon, SignOutIcon, WarningIcon } from '@/components/icons';
import { ThemeToggle } from '@/components/theme-toggle';
import { Wordmark } from '@/components/wordmark';
import { ApiError, getMe, listMeetings } from '@/lib/api-client';
import { clearAccessToken, readAccessToken } from '@/lib/auth-token';
import { formatMeetingTime } from '@/lib/date-time';
import { LATEST_MEETINGS_COUNT, latestMeetings } from '@/lib/meetings';

/**
 * Two omissions here are decisions.
 *
 * Checking the token and loading the data are one `loading` variant: they differ in the
 * effect's control flow, not in what is on screen, and a state nobody can observe is not a
 * state. Starting at `loading` is also what keeps the first render identical on the server and
 * during hydration, without reading storage to produce it.
 *
 * `ready` with an empty list is not its own variant either — nothing about the data flow
 * differs, and a variant restating a derivable fact is a second source of truth for it.
 *
 * `signedOut` does earn its place. This component stays mounted while Next navigates away, and
 * in that window it must render neither the user's email nor a spinner captioned "Loading your
 * meetings".
 */
type Dashboard =
  | { state: 'loading' }
  | { state: 'ready'; user: User; meetings: ReadonlyArray<Meeting> }
  | { state: 'failed'; message: string }
  | { state: 'signedOut' };

export function HomeDashboard() {
  const router = useRouter();
  const [dashboard, setDashboard] = useState<Dashboard>({ state: 'loading' });
  // Bumped by "Try again". The effect owns the whole load, so a retry re-runs it rather than
  // growing a second copy of the request logic inside a handler.
  const [reloadCount, setReloadCount] = useState(0);

  useEffect(() => {
    // Read here, never during render: `localStorage` does not exist while Next renders this on
    // the server, so a token-dependent first render would be a value the server could not have
    // produced — a hydration mismatch, and a flash of the wrong view before it resolved.
    const token = readAccessToken();

    if (token === null) {
      setDashboard({ state: 'signedOut' });
      router.replace('/auth/login');
      return;
    }

    // Ignores a response from a torn-down run. Strict Mode invokes this effect twice in
    // development, and "Try again" starts a second run while the first may still be in flight;
    // either way the older response must not land on the newer state.
    let active = true;

    async function load(bearer: string) {
      try {
        // Together, not in sequence: neither request feeds the other, both need only the token,
        // and the greeting and the list should appear in one commit rather than filling the
        // page in twice. `Promise.all` subscribes to both, so the second 401 — and a dead token
        // fails both — is handled rather than orphaned into an unhandled rejection.
        const [user, meetings] = await Promise.all([getMe(bearer), listMeetings(bearer)]);

        if (!active) {
          return;
        }

        // Updater form, so a load that resolves after the user pressed Log out cannot put the
        // dashboard back on screen mid-navigation.
        setDashboard((current) =>
          current.state === 'loading' ? { state: 'ready', user, meetings } : current,
        );
      } catch (error) {
        if (!active) {
          return;
        }

        if (error instanceof ApiError && error.status === 401) {
          // Cleared first: a token the API has rejected is worth nothing, and leaving it behind
          // means the next visit spends a round trip learning the same thing.
          clearAccessToken();
          setDashboard({ state: 'signedOut' });
          router.replace('/auth/login');
          return;
        }

        setDashboard((current) =>
          current.state === 'loading'
            ? { state: 'failed', message: describeFailure(error) }
            : current,
        );
      }
    }

    void load(token);

    return () => {
      active = false;
    };
    // `router` is stable across renders in the App Router, so it does not re-run this.
  }, [router, reloadCount]);

  function signOut() {
    // Local only. The JWT is stateless and there is no logout endpoint to call: the token stays
    // valid until it expires, which is a property of bearer tokens rather than a gap to fill.
    clearAccessToken();
    setDashboard({ state: 'signedOut' });
    router.replace('/auth/login');
  }

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
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Button variant="secondary" isDisabled={dashboard.state === 'loading'} onPress={signOut}>
            <SignOutIcon />
            Log out
          </Button>
        </div>
      </header>

      {dashboard.state === 'loading' && <LoadingShell />}

      {dashboard.state === 'failed' && (
        <Alert status="danger" role="alert">
          <Alert.Indicator>
            <WarningIcon />
          </Alert.Indicator>
          <Alert.Content>
            <Alert.Title>We could not load your meetings</Alert.Title>
            <Alert.Description>{dashboard.message}</Alert.Description>
          </Alert.Content>
          <Button
            variant="secondary"
            onPress={() => {
              setDashboard({ state: 'loading' });
              setReloadCount((count) => count + 1);
            }}
          >
            Try again
          </Button>
        </Alert>
      )}

      {dashboard.state === 'ready' && (
        <ReadyDashboard user={dashboard.user} meetings={dashboard.meetings} />
      )}
    </main>
  );
}

function ReadyDashboard({ user, meetings }: { user: User; meetings: ReadonlyArray<Meeting> }) {
  const latest = latestMeetings(meetings);
  const isEmpty = latest.length === 0;

  return (
    <>
      <section className="flex flex-col gap-1">
        <h1 className="text-3xl font-semibold tracking-tight text-balance">
          Welcome back, {user.displayName}
        </h1>
        {/* The email under the greeting rather than in it: `displayName` is derived server-side
            from the address, so putting both in one sentence reads doubled. */}
        <p className="text-muted text-sm">{user.email}</p>
      </section>

      <Card className="p-6">
        <div className="flex flex-col gap-1">
          <span className="text-4xl font-semibold tracking-tight tabular-nums">
            {meetings.length}
          </span>
          {/* The endpoint has no pagination, so this is every meeting the user hosts or
              attends. The day it grows a `?page=`, this stops being a total and starts being a
              page size, and the label below will quietly lie. */}
          <span className="text-muted text-sm">
            {meetings.length === 1 ? 'meeting' : 'meetings'} in total
          </span>
        </div>
      </Card>

      <Card className="gap-0 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <h2 className="text-lg font-semibold tracking-tight">Latest meetings</h2>
            {/* Both the subtitle and the header action are suppressed when the list is empty.
                The subtitle would describe an ordering of nothing, and the empty state carries
                its own primary call to action — two identical buttons in one card is a choice
                the reader has to make twice. */}
            {!isEmpty && (
              <p className="text-muted text-sm">
                The {LATEST_MEETINGS_COUNT} most recently scheduled, newest first.
              </p>
            )}
          </div>

          {/* An anchor, not a Button: this navigates, and Next's client-side routing needs a
              real link to hook. `buttonVariants` keeps it looking like the rest. */}
          {!isEmpty && (
            <Link href="/meetings/new" className={buttonVariants({ variant: 'primary' })}>
              <PlusIcon />
              New meeting
            </Link>
          )}
        </div>

        {isEmpty ? (
          <NoMeetings />
        ) : (
          <ul className="mt-6 flex flex-col">
            {latest.map((meeting, index) => (
              <li key={meeting.id} className="flex flex-col">
                {index > 0 && <Separator className="my-1" />}
                <MeetingRow meeting={meeting} isHost={meeting.hostId === user.id} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function MeetingRow({ meeting, isHost }: { meeting: Meeting; isHost: boolean }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate font-medium">{meeting.title}</span>
        <span className="text-muted text-sm">
          <time dateTime={meeting.scheduledAt}>{formatMeetingTime(meeting.scheduledAt)}</time>
          {' · '}
          {isHost ? 'Hosting' : 'Invited'}
        </span>
      </div>

      <StatusChip status={meeting.status} />
    </div>
  );
}

/**
 * Exhaustive by type, so adding an entry to `MEETING_STATUSES` is a typecheck error here rather
 * than a chip that renders untinted.
 *
 * Each label is an explicit string rather than a CSS `capitalize` over the raw status: a label
 * is copy, and copy that is really a text-transform cannot be reworded or translated.
 */
const STATUS_CHIP: Record<
  MeetingStatus,
  { color: 'accent' | 'success' | 'default'; variant: 'soft' | 'primary'; label: string }
> = {
  scheduled: { color: 'accent', variant: 'soft', label: 'Scheduled' },
  live: { color: 'success', variant: 'primary', label: 'Live' },
  ended: { color: 'default', variant: 'soft', label: 'Ended' },
};

function StatusChip({ status }: { status: MeetingStatus }) {
  const { color, variant, label } = STATUS_CHIP[status];

  return (
    <Chip color={color} variant={variant} size="sm">
      <Chip.Label>{label}</Chip.Label>
    </Chip>
  );
}

/**
 * A new account's first screen, so this is a designed view rather than a fallback: it says what
 * the list will hold and offers the one action that fills it.
 */
function NoMeetings() {
  return (
    <EmptyState className="mt-6 flex flex-col items-center gap-3 py-10 text-center">
      <span className="bg-accent/10 text-accent flex size-12 items-center justify-center rounded-full">
        <CalendarIcon />
      </span>
      <div className="flex flex-col gap-1">
        <p className="font-medium">No meetings yet</p>
        <p className="text-muted max-w-sm text-sm text-pretty">
          Schedule your first meeting and it will show up here, with everyone you invited.
        </p>
      </div>
      <Link href="/meetings/new" className={buttonVariants({ variant: 'primary' })}>
        <PlusIcon />
        New meeting
      </Link>
    </EmptyState>
  );
}

/**
 * The real shell, not a bare spinner: `ready` then fills this frame in rather than laying the
 * page out from scratch, so nothing jumps.
 *
 * The bars are `aria-hidden` because a row of grey rectangles read aloud is noise. The sentence
 * in the `output` is what a screen reader gets instead — an `output` rather than a `div` with
 * `role="status"` because it is the element that already means this, and it holds only text,
 * which is all its content model allows.
 */
function LoadingShell() {
  return (
    <>
      <output className="sr-only">Loading your meetings</output>

      <div className="flex flex-col gap-8" aria-hidden="true">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-9 w-64 rounded-lg" />
          <Skeleton className="h-4 w-40 rounded" />
        </div>

        <Card className="p-6">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-10 w-16 rounded-lg" />
            <Skeleton className="h-4 w-28 rounded" />
          </div>
        </Card>

        <Card className="gap-6 p-6">
          <Skeleton className="h-6 w-40 rounded" />
          <div className="flex flex-col gap-4">
            {Array.from({ length: LATEST_MEETINGS_COUNT }, (_, index) => (
              <Skeleton key={index} className="h-12 w-full rounded-lg" />
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}

/**
 * Turns a thrown value into something to show.
 *
 * A 401 never reaches this — that branch clears the token and redirects — which is what makes
 * rendering the message safe: a 401's `ApiError.message` is Nest's bare "Unauthorized", which
 * tells a reader nothing.
 */
function describeFailure(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }

  // `fetch` rejects rather than resolving when the request never reached the API at all.
  return 'We could not reach the server. Check your connection and try again.';
}
