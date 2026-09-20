'use client';

import type { User } from '@repo/shared';
import { useEffect, useState } from 'react';

import { fetchAvatar } from '@/lib/api-client';

import { UserInitials } from './user-initials';

/** The two circles the app draws, kept in one place so the header and the profile cannot
 *  disagree about a person's size on screen. Matches `UserInitials`. */
const SIZE_CLASS: Record<'sm' | 'lg', string> = {
  sm: 'size-8',
  lg: 'size-16',
};

/**
 * The circle that stands for a person: their picture when they have one, their initials when
 * they do not.
 *
 * **The image is fetched, not pointed at.** An `<img src>` cannot carry the bearer header the
 * avatar route requires, so the bytes come back as a blob and are rendered from an object URL
 * — the same shape the meeting-file thumbnail uses, and one more thing the `HttpOnly` cookie
 * migration would simplify away.
 *
 * **`avatarVersion` is what makes a new picture appear.** The path is the same for every
 * avatar this account will ever have, so nothing about the URL says the image behind it
 * changed; the fetch is keyed on the version instead, and the response is `no-store` so no
 * cache can answer with the old one.
 *
 * `aria-hidden`, always — both call sites render the name next to it, and announcing the
 * picture would read the same person twice. A failed fetch falls back to initials rather than
 * an error: a missing picture is a cosmetic loss, and the circle is never empty.
 */
export function UserAvatar({
  token,
  user,
  size = 'sm',
}: {
  token: string;
  user: User;
  size?: 'sm' | 'lg';
}) {
  const { avatarPath, avatarVersion, displayName } = user;
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (avatarPath === undefined) {
      setUrl(null);

      return;
    }

    // Ignores a response from a torn-down run. Strict Mode invokes this twice in development,
    // and a replacement starts a second fetch while the first may still be in flight; either
    // way the older blob must not land on the newer state.
    let active = true;

    void fetchAvatar(token)
      .then((blob) => {
        if (active) {
          setUrl(URL.createObjectURL(blob));
        }
      })
      .catch(() => {
        if (active) {
          setUrl(null);
        }
      });

    return () => {
      active = false;
    };
    // `avatarVersion` rather than the path, which never changes: it is the whole reason the
    // API sends a version at all.
  }, [token, avatarPath, avatarVersion]);

  // Revoking lives in its own effect, and that is not tidiness. React runs this cleanup only
  // after the DOM already holds the *next* URL, so the browser never has an `<img>` pointing
  // at a blob that has been freed. Revoking inside the fetch effect above would release the
  // picture on screen the moment a replacement started loading, and the user would watch a
  // broken image while the new one arrived.
  useEffect(() => {
    if (url === null) {
      return;
    }

    return () => {
      URL.revokeObjectURL(url);
    };
  }, [url]);

  if (url === null) {
    return <UserInitials displayName={displayName} size={size} />;
  }

  // Decorative: the name beside it is the accessible text, exactly as for the initials it
  // replaces. `object-cover` is belt and braces — the server already serves a square.
  return (
    <img
      src={url}
      alt=""
      aria-hidden="true"
      className={`${SIZE_CLASS[size]} shrink-0 rounded-full object-cover`}
    />
  );
}
