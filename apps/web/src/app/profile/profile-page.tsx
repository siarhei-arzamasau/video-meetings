'use client';

import { Alert, Button, Card, Separator, Skeleton, Spinner, buttonVariants } from '@heroui/react';
import type { User } from '@repo/shared';
import Link from 'next/link';

import { ArrowLeftIcon, SignOutIcon, WarningIcon } from '@/components/icons';
import { ThemeToggle } from '@/components/theme-toggle';
import { UserInitials } from '@/components/user-initials';
import { Wordmark } from '@/components/wordmark';
import { formatJoinDate } from '@/lib/date-time';
import { useSignedIn } from '@/lib/use-signed-in';

/**
 * The account the token names. It adds no request of its own — `getMe` inside the gate is
 * already the whole of this page's data, so there is no second load to sequence and no state
 * beyond the gate's.
 */
export function ProfilePage() {
  const { session, signOut } = useSignedIn();

  if (session.state === 'signedOut') {
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

      {/* Outside the switch: the heading names the page whatever the gate is doing, and an
          empty shell that is briefly public may say which page it is. */}
      <h1 className="text-3xl font-semibold tracking-tight text-balance">Your profile</h1>

      {session.state === 'failed' && (
        <Alert status="danger" role="alert">
          <Alert.Indicator>
            <WarningIcon />
          </Alert.Indicator>
          <Alert.Content>
            <Alert.Title>We could not load your profile</Alert.Title>
            <Alert.Description>{session.message}</Alert.Description>
          </Alert.Content>
          <Button variant="secondary" onPress={session.retry}>
            Try again
          </Button>
        </Alert>
      )}

      {session.state === 'loading' && <LoadingShell />}

      {session.state === 'ready' && <AccountCard user={session.user} />}
    </main>
  );
}

function AccountCard({ user }: { user: User }) {
  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-center gap-5">
        <UserInitials displayName={user.displayName} size="lg" />

        <div className="flex min-w-0 flex-col gap-0.5">
          {/* A `p`, not an `h2`: the name is the page's subject, which `h1` has already
              announced, and a heading here would put the same thing in the outline twice. */}
          {/* Wrapped, not truncated: a name and an address are the two things on this page
              the reader came to read, and an ellipsis here would hide the end of the very value
              they are checking. `break-words` is what lets an address with no spaces in it
              reflow instead of running out of the card. */}
          <p className="text-2xl font-semibold tracking-tight break-words">{user.displayName}</p>
          <p className="text-muted text-sm break-words">{user.email}</p>
          <p className="text-muted text-sm">
            {/* The day, not the instant: `formatJoinDate` drops the time, and the `datetime`
                attribute keeps the exact value for anything reading the markup. */}
            Joined <time dateTime={user.createdAt}>{formatJoinDate(user.createdAt)}</time>
          </p>
        </div>
      </div>

      <Separator className="my-6" />

      {/* An anchor, not a Button: this navigates, and Next's client-side routing needs a real
          link to hook. */}
      <Link href="/profile/edit" className={`${buttonVariants({ variant: 'primary' })} w-fit`}>
        Edit profile
      </Link>
    </Card>
  );
}

/**
 * The card's own frame, so `ready` fills it in rather than laying the page out from scratch.
 * The bars are `aria-hidden` and the `output` carries the sentence a screen reader gets.
 */
function LoadingShell() {
  return (
    <>
      <output className="sr-only">Loading your profile</output>

      <Card className="p-6" aria-hidden="true">
        <div className="flex flex-wrap items-center gap-5">
          <Skeleton className="size-16 rounded-full" />
          <div className="flex flex-col gap-2">
            <Skeleton className="h-7 w-48 rounded-lg" />
            <Skeleton className="h-4 w-56 rounded" />
            <Skeleton className="h-4 w-36 rounded" />
          </div>
        </div>

        <Separator className="my-6" />

        <Skeleton className="h-10 w-32 rounded-lg" />
      </Card>
    </>
  );
}
