'use client';

import { Alert, Button, Spinner } from '@heroui/react';
import Link from 'next/link';

import { ArrowLeftIcon, SignOutIcon, WarningIcon } from '@/components/icons';
import { ThemeToggle } from '@/components/theme-toggle';
import { Wordmark } from '@/components/wordmark';
import { useSignedIn } from '@/lib/use-signed-in';

import { DisplayNameSection, DisplayNameSkeleton } from './display-name-section';

/**
 * Everything about the account the user can change, one card per thing. Phases 4 and 6 add
 * their sections — password, avatar — to this page rather than to routes of their own, which
 * is why this file owns the gate and nothing else: each section is its own module, owning its
 * request, its state, and its skeleton, and this page only decides which ones exist.
 *
 * Gated on the client like every other protected route, and adding no request of its own:
 * `getMe` inside the gate is the whole of what the form starts from.
 */
export function EditProfilePage() {
  const { session, signOut, updateUser } = useSignedIn();

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
        <div className="flex flex-wrap items-center justify-end gap-2">
          <ThemeToggle />
          <Button variant="secondary" isDisabled={session.state === 'loading'} onPress={signOut}>
            <SignOutIcon />
            Log out
          </Button>
        </div>
      </header>

      {/* Back to the profile, not to the meetings: this page was reached from there, and a
          link that skipped it would strand the reader one level from where they started. */}
      <Link
        href="/profile"
        className="text-muted hover:text-foreground focus-visible:ring-focus -mt-4 inline-flex w-fit items-center gap-1.5 rounded text-sm transition-colors outline-none focus-visible:ring-2"
      >
        <ArrowLeftIcon />
        Back to your profile
      </Link>

      {/* Outside the switch, as on the profile: the heading names the page whatever the gate
          is doing, and an empty shell that is briefly public may say which page it is. */}
      <h1 className="text-3xl font-semibold tracking-tight text-balance">Edit your profile</h1>

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

      {session.state === 'loading' && (
        <>
          {/* The bars are `aria-hidden` and this `output` carries the sentence a screen reader
              gets — one for the page, however many skeletons the sections contribute. */}
          <output className="sr-only">Loading your profile</output>
          <DisplayNameSkeleton />
        </>
      )}

      {session.state === 'ready' && (
        <DisplayNameSection
          user={session.user}
          token={session.token}
          onSaved={updateUser}
          onUnauthorized={signOut}
        />
      )}
    </main>
  );
}
