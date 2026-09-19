'use client';

import {
  Alert,
  Button,
  Card,
  EmptyState,
  Separator,
  Skeleton,
  Spinner,
  buttonVariants,
} from '@heroui/react';
import type { Meeting, User } from '@repo/shared';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { CalendarIcon, PlusIcon, SignOutIcon, WarningIcon } from '@/components/icons';
import { MeetingStatusChip } from '@/components/meeting-status-chip';
import { ThemeToggle } from '@/components/theme-toggle';
import { Wordmark } from '@/components/wordmark';
import { ApiError, listMeetings } from '@/lib/api-client';
import { formatMeetingTime } from '@/lib/date-time';
import { LATEST_MEETINGS_COUNT, latestMeetings } from '@/lib/meetings';
import { describeFailure, useSignedIn } from '@/lib/use-signed-in';

/**
 * The meetings list, once the gate has a user. `ready` with an empty list is not its own
 * variant: nothing about the data flow differs, and a variant restating a derivable fact is a
 * second source of truth for it.
 */
type Dashboard =
  | { state: 'loading' }
  | { state: 'ready'; user: User; meetings: ReadonlyArray<Meeting> }
  | { state: 'failed'; message: string; retry(): void }
  | { state: 'signedOut' };

type MeetingsList =
  | { state: 'loading' }
  | { state: 'ready'; meetings: ReadonlyArray<Meeting> }
  | { state: 'failed'; message: string };

export function HomeDashboard() {
  // The gate — token read, `getMe`, 401 redirect — lives in the hook now that the meeting page
  // shares it. What stays here is the one request this page adds: the list.
  const { session, signOut } = useSignedIn();
  const [list, setList] = useState<MeetingsList>({ state: 'loading' });
  const [reloadCount, setReloadCount] = useState(0);
  const token = session.state === 'ready' ? session.token : null;

  useEffect(() => {
    if (token === null) {
      return;
    }

    let active = true;

    async function load(bearer: string) {
      try {
        const meetings = await listMeetings(bearer);

        if (active) {
          setList({ state: 'ready', meetings });
        }
      } catch (error) {
        if (!active) {
          return;
        }

        if (error instanceof ApiError && error.status === 401) {
          // The token went bad between the two requests. Same answer as the gate's.
          signOut();

          return;
        }

        setList({ state: 'failed', message: describeFailure(error) });
      }
    }

    void load(token);

    return () => {
      active = false;
    };
  }, [token, signOut, reloadCount]);

  // One `loading` on screen for both the gate and the list: they differ in control flow, not
  // in what the reader sees, and starting there keeps the first render identical on the server.
  const dashboard: Dashboard =
    session.state === 'signedOut'
      ? { state: 'signedOut' }
      : session.state === 'failed'
        ? { state: 'failed', message: session.message, retry: session.retry }
        : session.state === 'loading' || list.state === 'loading'
          ? { state: 'loading' }
          : list.state === 'failed'
            ? {
                state: 'failed',
                message: list.message,
                retry: () => {
                  setList({ state: 'loading' });
                  setReloadCount((count) => count + 1);
                },
              }
            : { state: 'ready', user: session.user, meetings: list.meetings };

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
          <Button variant="secondary" onPress={dashboard.retry}>
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

/**
 * A `Link`, not a `Button` with `onPress`: this navigates, and Next's client-side routing needs a
 * real anchor to hook. The whole row is the target so the tap area on a phone is the row, not
 * the title; `-mx-2 px-2` lets the focus ring and hover surface clear the text.
 */
function MeetingRow({ meeting, isHost }: { meeting: Meeting; isHost: boolean }) {
  return (
    <Link
      href={`/meetings/${meeting.id}`}
      className="hover:bg-surface-secondary focus-visible:ring-focus -mx-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg px-2 py-3 transition-colors outline-none focus-visible:ring-2"
    >
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate font-medium">{meeting.title}</span>
        <span className="text-muted text-sm">
          <time dateTime={meeting.scheduledAt}>{formatMeetingTime(meeting.scheduledAt)}</time>
          {' · '}
          {isHost ? 'Hosting' : 'Invited'}
        </span>
      </span>

      <MeetingStatusChip status={meeting.status} />
    </Link>
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
