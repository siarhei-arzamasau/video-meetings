'use client';

import type { User } from '@repo/shared';
import { useEffect, useState } from 'react';

import { ApiError, deleteAvatar, uploadAvatar } from '@/lib/api-client';
import { validateAvatarFile } from '@/lib/avatar';

export type Save =
  | { state: 'idle' }
  | { state: 'working' }
  | { state: 'saved'; message: string }
  | { state: 'failed'; message: string };

/** A file the user has chosen and not yet uploaded, with the object URL its preview draws. */
export interface Chosen {
  file: File;
  previewUrl: string;
}

export interface AvatarPicture {
  chosen: Chosen | null;
  save: Save;
  isWorking: boolean;
  /** Takes what the file input produced: validated, previewed, or refused with a sentence. */
  choose: (file: File | undefined) => void;
  upload: () => void;
  remove: () => void;
}

/**
 * Everything the picture section does that is not markup: which file is chosen, what the last
 * request did, and the two requests themselves.
 *
 * Its own module because the section's logic had grown past what a component body may hold,
 * and because the two are different things to read — one is a state machine over a file and a
 * request, the other is a card with three buttons in it.
 *
 * **Nothing about the file is sent until it passes the shared rules.** Type, emptiness, and
 * size are checked at selection, before the file is even previewed: a 6 MB photo should be
 * refused where it was chosen, not after it has been uploaded.
 */
export function useAvatarPicture({
  token,
  onSaved,
  onUnauthorized,
}: {
  token: string;
  onSaved: (user: User) => void;
  onUnauthorized: () => void;
}): AvatarPicture {
  const [chosen, setChosen] = useState<Chosen | null>(null);
  const [save, setSave] = useState<Save>({ state: 'idle' });

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

  function choose(file: File | undefined): void {
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

  async function run(action: () => Promise<User>, message: string): Promise<void> {
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

  return {
    chosen,
    save,
    isWorking: save.state === 'working',
    choose,
    upload: () => {
      if (chosen !== null) {
        void run(() => uploadAvatar(token, chosen.file), 'Your picture is saved.');
      }
    },
    remove: () => {
      void run(() => deleteAvatar(token), 'Your picture is removed.');
    },
  };
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
