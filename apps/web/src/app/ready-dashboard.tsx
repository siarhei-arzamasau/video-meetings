import { Card, EmptyState, Separator, buttonVariants } from '@heroui/react';
import type { Meeting, User } from '@repo/shared';
import Link from 'next/link';

import { CalendarIcon, PlusIcon } from '@/components/icons';
import { MeetingStatusChip } from '@/components/meeting-status-chip';
import { formatMeetingTime } from '@/lib/date-time';
import { LATEST_MEETINGS_COUNT, latestMeetings } from '@/lib/meetings';

/**
 * The dashboard once the gate has a user and the meetings have loaded: greeting, total, latest.
 * `meetings` is the latest few the API was asked for, never the whole list, so the total is
 * its own number.
 */
export function ReadyDashboard({
  user,
  meetings,
  total,
}: {
  user: User;
  meetings: ReadonlyArray<Meeting>;
  total: number;
}) {
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
          <span className="text-4xl font-semibold tracking-tight tabular-nums">{total}</span>
          {/* Counted by the API, not the length of the list below it: that list is the latest
              few, and counting it would make this a page size that the label calls a total. */}
          <span className="text-muted text-sm">
            {total === 1 ? 'meeting' : 'meetings'} in total
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
