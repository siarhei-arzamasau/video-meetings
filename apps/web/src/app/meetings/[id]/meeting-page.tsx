'use client';

import { Alert, Button, Card, Skeleton, Spinner } from '@heroui/react';
import type { Meeting, User } from '@repo/shared';
import Link from 'next/link';
import { notFound, useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { ArrowLeftIcon, SignOutIcon, WarningIcon } from '@/components/icons';
import { MeetingStatusChip } from '@/components/meeting-status-chip';
import { ThemeToggle } from '@/components/theme-toggle';
import { Wordmark } from '@/components/wordmark';
import { ApiError, getMeeting } from '@/lib/api-client';
import { formatMeetingTime } from '@/lib/date-time';
import { describeFailure, useSignedIn } from '@/lib/use-signed-in';
import { FilesSection } from './files/files-section';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * `notFound` is a variant rather than a call inside the effect: `notFound()` must be thrown
 * during render for Next to swap in `not-found.tsx`, so the effect records the fact and the
 * render acts on it. A 404 covers both "no such meeting" and "not yours", by the API's design.
 */
type MeetingState =
  | { state: 'loading' }
  | { state: 'ready'; meeting: Meeting }
  | { state: 'notFound' }
  | { state: 'failed'; message: string };

export function MeetingPage() {
  const params = useParams<{ id: string }>();
  const meetingId = params.id;
  const { session, signOut } = useSignedIn();
  const [meeting, setMeeting] = useState<MeetingState>({ state: 'loading' });
  const [reloadCount, setReloadCount] = useState(0);
  const token = session.state === 'ready' ? session.token : null;

  useEffect(() => {
    if (token === null || !UUID_V4.test(meetingId)) {
      return;
    }

    let active = true;

    async function load(bearer: string) {
      try {
        const loaded = await getMeeting(bearer, meetingId);

        if (active) {
          setMeeting({ state: 'ready', meeting: loaded });
        }
      } catch (error) {
        if (!active) {
          return;
        }

        if (error instanceof ApiError && error.status === 401) {
          signOut();

          return;
        }

        if (error instanceof ApiError && error.status === 404) {
          setMeeting({ state: 'notFound' });

          return;
        }

        setMeeting({ state: 'failed', message: describeFailure(error) });
      }
    }

    void load(token);

    return () => {
      active = false;
    };
  }, [token, meetingId, signOut, reloadCount]);

  // A malformed id is not a meeting, and the API would answer 400 rather than 404 for it.
  if (!UUID_V4.test(meetingId) || meeting.state === 'notFound') {
    notFound();
  }

  if (session.state === 'signedOut') {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-3 p-6">
        <Spinner size="sm" />
        <p className="text-muted text-sm">Taking you to sign in…</p>
      </main>
    );
  }

  const failure =
    session.state === 'failed'
      ? { message: session.message, retry: session.retry }
      : meeting.state === 'failed'
        ? {
            message: meeting.message,
            retry: () => {
              setMeeting({ state: 'loading' });
              setReloadCount((count) => count + 1);
            },
          }
        : null;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-8 px-6 py-10">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <Wordmark />
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Button variant="secondary" isDisabled={session.state === 'loading'} onPress={signOut}>
            <SignOutIcon />
            Log out
          </Button>
        </div>
      </header>

      <Link
        href="/"
        className="text-muted hover:text-foreground focus-visible:ring-focus -mt-4 inline-flex w-fit items-center gap-1.5 rounded text-sm transition-colors outline-none focus-visible:ring-2"
      >
        <ArrowLeftIcon />
        Back to your meetings
      </Link>

      {failure !== null ? (
        <Alert status="danger" role="alert">
          <Alert.Indicator>
            <WarningIcon />
          </Alert.Indicator>
          <Alert.Content>
            <Alert.Title>We could not load this meeting</Alert.Title>
            <Alert.Description>{failure.message}</Alert.Description>
          </Alert.Content>
          <Button variant="secondary" onPress={failure.retry}>
            Try again
          </Button>
        </Alert>
      ) : session.state === 'ready' && meeting.state === 'ready' ? (
        <>
          <MeetingHeader meeting={meeting.meeting} user={session.user} />
          <FilesSection
            token={session.token}
            meeting={meeting.meeting}
            user={session.user}
            onUnauthorized={signOut}
          />
        </>
      ) : (
        <LoadingShell />
      )}
    </main>
  );
}

/**
 * "Hosted by you" or "by another member": there is no user lookup endpoint, so a host's name
 * is out of reach for a participant. Stated as a limitation rather than papered over with an
 * id.
 */
function MeetingHeader({ meeting, user }: { meeting: Meeting; user: User }) {
  const count = meeting.participantIds.length;
  const participants =
    count === 0
      ? 'No participants'
      : count === 1
        ? '1 participant'
        : `${String(count)} participants`;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-3xl font-semibold tracking-tight text-balance">{meeting.title}</h1>
        <MeetingStatusChip status={meeting.status} />
      </div>
      <p className="text-muted flex flex-wrap gap-x-2 text-sm">
        <time dateTime={meeting.scheduledAt}>{formatMeetingTime(meeting.scheduledAt)}</time>
        <span aria-hidden="true">·</span>
        <span>{meeting.hostId === user.id ? 'Hosted by you' : 'Hosted by another member'}</span>
        <span aria-hidden="true">·</span>
        <span>{participants}</span>
      </p>
    </section>
  );
}

function LoadingShell() {
  return (
    <>
      <output className="sr-only">Loading the meeting</output>

      <div className="flex flex-col gap-8" aria-hidden="true">
        <div className="flex flex-col gap-3">
          <Skeleton className="h-9 w-72 rounded-lg" />
          <Skeleton className="h-4 w-80 rounded" />
        </div>

        <Card className="gap-6 p-6">
          <Skeleton className="h-6 w-24 rounded" />
          <Skeleton className="h-12 w-full rounded-lg" />
        </Card>
      </div>
    </>
  );
}
