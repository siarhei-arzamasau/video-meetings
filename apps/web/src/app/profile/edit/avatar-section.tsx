'use client';

import { Alert, Button, Card, Skeleton, Spinner } from '@heroui/react';
import { AVATAR_ACCEPT, MAX_AVATAR_SIZE_BYTES, type User } from '@repo/shared';
import { useEffect, useRef, useState, type ChangeEvent } from 'react';

import { CheckIcon, WarningIcon } from '@/components/icons';
import { UserAvatar } from '@/components/user-avatar';
import { ApiError, deleteAvatar, uploadAvatar } from '@/lib/api-client';
import { validateAvatarFile } from '@/lib/avatar';

type Save =
  | { state: 'idle' }
  | { state: 'working' }
  | { state: 'saved'; message: string }
  | { state: 'failed'; message: string };

/** A file the user has chosen and not yet uploaded, with the object URL its preview draws. */
interface Chosen {
  file: File;
  previewUrl: string;
}

const MEGABYTE = 1024 * 1024;

/**
 * The picture, from the edit page.
 *
 * **A chosen file is previewed locally and uploaded only when asked.** The preview is an
 * object URL over the file itself, so it costs no request and shows exactly what the user
 * picked — which is also why it is not square: what the server crops to is the thing they see
 * afterwards, in the circle above.
 *
 * **Nothing about the file is sent until it passes the shared rules.** Type, emptiness, and
 * size are checked at selection, before the file is even previewed: a 6 MB photo should be
 * refused where it was chosen, not after it has been uploaded.
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
  const [chosen, setChosen] = useState<Chosen | null>(null);
  const [save, setSave] = useState<Save>({ state: 'idle' });
  const fileInput = useRef<HTMLInputElement>(null);

  // The preview's object URL outlives no more than the choice that created it. Its own effect
  // for the reason `UserAvatar` gives: the cleanup runs after the DOM holds the next one, so
  // the `<img>` is never left pointing at a blob that has been freed.
  useEffect(() => {
    if (chosen === null) {
      return;
    }

    const { previewUrl } = chosen;

    return () => {
      URL.revokeObjectURL(previewUrl);
    };
  }, [chosen]);

  const isWorking = save.state === 'working';

  function handleChoose(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    // The input is reset either way, so choosing the same file twice in a row still fires a
    // change event — without it, a user who fixed a file under the same name could not retry.
    event.target.value = '';

    if (file === undefined) {
      return;
    }

    const failure = validateAvatarFile(file);

    if (failure !== null) {
      setChosen(null);
      setSave({ state: 'failed', message: failure });

      return;
    }

    setChosen({ file, previewUrl: URL.createObjectURL(file) });
    setSave({ state: 'idle' });
  }

  async function run(action: () => Promise<User>, message: string) {
    setSave({ state: 'working' });

    try {
      const updated = await action();

      onSaved(updated);
      setChosen(null);
      setSave({ state: 'saved', message });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        // The token went bad between the gate's load and this request. Same answer as the
        // gate's: clear it and go to sign-in.
        onUnauthorized();

        return;
      }

      setSave({ state: 'failed', message: describeFailure(error) });
    }
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
            <Button
              variant="primary"
              isDisabled={isWorking}
              onPress={() => {
                void run(() => uploadAvatar(token, chosen.file), 'Your picture is saved.');
              }}
            >
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
            <Button
              variant="secondary"
              isDisabled={isWorking}
              onPress={() => {
                void run(() => deleteAvatar(token), 'Your picture is removed.');
              }}
            >
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
 * Turns a thrown value into something to show.
 *
 * Every rejection here belongs to the section rather than to a field: there is one input, and
 * its own refusals never reach the network. What does reach it is the server decoding the
 * bytes — a 415 or a 400 whose message is the shared sentence the form would have shown had it
 * been able to look inside the file.
 */
function describeFailure(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }

  // `fetch` rejects rather than resolving when the request never reached the API at all.
  return 'We could not reach the server. Check your connection and try again.';
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
