'use client';

import { Alert, Button, Card, Skeleton, Spinner } from '@heroui/react';
import { AVATAR_ACCEPT, MAX_AVATAR_SIZE_BYTES, type User } from '@repo/shared';
import { useRef, type ChangeEvent } from 'react';

import { CheckIcon, WarningIcon } from '@/components/icons';
import { UserAvatar } from '@/components/user-avatar';

import { useAvatarPicture } from './use-avatar-picture';

const MEGABYTE = 1024 * 1024;

/**
 * The picture, from the edit page.
 *
 * **A chosen file is previewed locally and uploaded only when asked.** The preview is an
 * object URL over the file itself, so it costs no request and shows exactly what the user
 * picked — which is also why it is not square: what the server crops to is the thing they see
 * afterwards, in the circle above.
 *
 * What is chosen, what the last request did, and the requests themselves are
 * `useAvatarPicture`; this file is the card those states are drawn as.
 *
 * Both a successful upload and a removal hand the updated user back through `onSaved`, and
 * that single call is what makes the profile and the home header change without a reload —
 * the record carries a new `avatarVersion`, and every `UserAvatar` keyed on it re-fetches.
 */
export function AvatarSection({
  user,
  token,
  onSaved,
  onUnauthorized,
}: {
  user: User;
  token: string;
  onSaved: (user: User) => void;
  onUnauthorized: () => void;
}) {
  const { chosen, save, isWorking, choose, upload, remove } = useAvatarPicture({
    token,
    onSaved,
    onUnauthorized,
  });
  const fileInput = useRef<HTMLInputElement>(null);

  function handleChoose(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    // The input is reset either way, so choosing the same file twice in a row still fires a
    // change event — without it, a user who fixed a file under the same name could not retry.
    event.target.value = '';

    choose(file);
  }

  return (
    <Card className="p-6">
      <Card.Header className="gap-1.5 p-0">
        {/* An `h2`, as every section on this page is: the only heading above them is the `h1`. */}
        <Card.Title
          className="text-lg"
          render={({ children, ...props }) => <h2 {...props}>{children}</h2>}
        >
          Picture
        </Card.Title>
        <Card.Description>
          Shown next to your name wherever you appear. We crop it to a square for you.
        </Card.Description>
      </Card.Header>

      <div className="mt-6 flex flex-col items-start gap-5">
        {save.state === 'failed' && (
          <Alert status="danger" role="alert">
            <Alert.Indicator>
              <WarningIcon />
            </Alert.Indicator>
            <Alert.Content>
              <Alert.Title>We could not change your picture</Alert.Title>
              <Alert.Description>{save.message}</Alert.Description>
            </Alert.Content>
          </Alert>
        )}

        {save.state === 'saved' && (
          // Polite rather than an alert: it answers something the reader just did.
          <output className="block w-full">
            <Alert status="success">
              <Alert.Indicator>
                <CheckIcon />
              </Alert.Indicator>
              <Alert.Content>
                <Alert.Description>{save.message}</Alert.Description>
              </Alert.Content>
            </Alert>
          </output>
        )}

        <div className="flex flex-wrap items-center gap-5">
          {/* The picture as it is now, at the size the profile draws it — so "what I have"
              and "what I am replacing it with" are side by side rather than one after the
              other. */}
          <UserAvatar token={token} user={user} size="lg" />

          {chosen !== null && (
            <div className="flex items-center gap-3">
              <span aria-hidden="true" className="text-muted text-2xl leading-none">
                →
              </span>
              {/* Uncropped on purpose: the circle on the left is what the square will look
                  like, and this is what the user actually chose. `bg-default` is not
                  decoration — a dark or part-transparent picture is otherwise invisible
                  against the card, and the preview would read as a missing image. */}
              <img
                src={chosen.previewUrl}
                alt=""
                aria-hidden="true"
                className="bg-default size-16 shrink-0 rounded-lg object-contain"
              />
              <p className="text-muted max-w-40 truncate text-sm" title={chosen.file.name}>
                {chosen.file.name}
              </p>
            </div>
          )}
        </div>

        {/* A real file input, hidden and driven by the button below: the native control cannot
            be styled to match, and reimplementing it would mean reimplementing the file dialog.
            It is taken out of the tab order and out of the accessibility tree on purpose — left
            in, it is a second stop for the same action with no focus ring to show for it, and a
            screen reader announces the same control twice. The visible button is the control;
            `aria-label` stays only so tests can address the input by name. */}
        <input
          ref={fileInput}
          type="file"
          name="avatar"
          accept={AVATAR_ACCEPT.join(',')}
          onChange={handleChoose}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          aria-label="Choose a picture"
        />

        <p className="text-muted text-sm">
          PNG, JPEG, or WebP, up to {MAX_AVATAR_SIZE_BYTES / MEGABYTE} MB.
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="secondary"
            isDisabled={isWorking}
            onPress={() => fileInput.current?.click()}
          >
            {chosen === null ? 'Choose a picture' : 'Choose a different one'}
          </Button>

          {chosen !== null && (
            <Button variant="primary" isDisabled={isWorking} onPress={upload}>
              {isWorking ? (
                <>
                  <Spinner size="sm" />
                  Uploading…
                </>
              ) : (
                'Upload'
              )}
            </Button>
          )}

          {/* Only when there is one to remove: a control that does nothing is a control that
              makes the reader wonder what it would have done. */}
          {user.avatarPath !== undefined && chosen === null && (
            <Button variant="secondary" isDisabled={isWorking} onPress={remove}>
              {isWorking ? (
                <>
                  <Spinner size="sm" />
                  Removing…
                </>
              ) : (
                'Remove picture'
              )}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

/**
 * This section's own frame, so `ready` fills it in rather than laying the page out from
 * scratch. A circle and two controls, which is the shape the loaded section has.
 */
export function AvatarSkeleton() {
  return (
    <Card className="gap-6 p-6" aria-hidden="true">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-24 rounded" />
        <Skeleton className="h-4 w-80 max-w-full rounded" />
      </div>

      <Skeleton className="size-16 rounded-full" />

      <div className="flex gap-3">
        <Skeleton className="h-10 w-40 rounded-lg" />
        <Skeleton className="h-10 w-36 rounded-lg" />
      </div>
    </Card>
  );
}
