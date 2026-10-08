'use client';

import type { MeetingFile } from '@repo/shared';
import { useEffect, useRef, useState } from 'react';

import { ApiError, fetchTranscript } from '@/lib/api-client';

/** The browser refused the tab. Nothing was requested: there is nowhere to show the answer. */
const BLOCKED_MESSAGE =
  'Your browser blocked the new tab. Allow pop-ups for this site, then try again.';
const FAILED_MESSAGE = 'The transcript could not be opened. Try again.';

export interface Transcript {
  /** Why the last attempt failed, for the row to show inline. `null` when nothing did. */
  error: string | null;
  isOpening: boolean;
  /** Opens the transcript in a new tab. **Call it from inside the press**, not after an await. */
  open(): void;
  dismiss(): void;
}

/**
 * Opens a recording's transcript in a new tab.
 *
 * The route needs the bearer header, which a link cannot send, so the text is fetched and
 * shown from an object URL — and **the tab is opened first, inside the press, and pointed at
 * the text when it arrives.** A tab opened after the `await` is a popup as far as a browser is
 * concerned, and several block it without saying so.
 *
 * **A row fetches its transcript once.** A stored transcript never changes — nothing sends a
 * transcribed recording back to the queue — so the first answer's object URL serves every
 * later press, each in a tab of its own. Asked again every time, a row held one more copy of
 * the text per press for as long as the page stayed open.
 *
 * That URL lives as long as the row and is revoked when it goes. Revoked as soon as the tab
 * had it — what the download does — the tab could not be reloaded; and a row that is gone is
 * a recording that was deleted, whose transcript should stop opening.
 *
 * A 401 goes to `onUnauthorized`, like every other request the row makes.
 */
export function useTranscript(
  token: string,
  { id, meetingId }: Pick<MeetingFile, 'id' | 'meetingId'>,
  onUnauthorized: () => void,
): Transcript {
  const [error, setError] = useState<string | null>(null);
  const [isOpening, setIsOpening] = useState(false);
  /** The row's one object URL, made by the first press that was answered. */
  const fetched = useRef<{ url: string | null }>({ url: null });
  const isMounted = useRef(false);

  useEffect(() => {
    const held = fetched.current;
    isMounted.current = true;

    return () => {
      isMounted.current = false;

      if (held.url !== null) {
        URL.revokeObjectURL(held.url);
        held.url = null;
      }
    };
  }, []);

  async function show(tab: Window): Promise<void> {
    try {
      const transcript = await fetchTranscript(token, meetingId, id);

      if (!isMounted.current) {
        // The row went while the text was on its way: nothing is left to revoke a URL.
        tab.close();

        return;
      }

      // `??=`: two presses that were both still waiting share whichever answer came first.
      fetched.current.url ??= URL.createObjectURL(transcript);
      tab.location.replace(fetched.current.url);
    } catch (failure) {
      // An empty tab left open would read as a transcript that is blank.
      tab.close();

      if (failure instanceof ApiError && failure.status === 401) {
        onUnauthorized();

        return;
      }

      setError(failure instanceof ApiError ? failure.message : FAILED_MESSAGE);
    } finally {
      setIsOpening(false);
    }
  }

  function open(): void {
    const tab = window.open('', '_blank');

    if (tab === null) {
      setError(BLOCKED_MESSAGE);

      return;
    }

    // `noopener` would have handed back no window to point at the text, so the link back to
    // this page is cut here instead: what the tab shows has no business reaching it.
    tab.opener = null;
    setError(null);

    if (fetched.current.url !== null) {
      tab.location.replace(fetched.current.url);

      return;
    }

    setIsOpening(true);
    void show(tab);
  }

  return { error, isOpening, open, dismiss: () => setError(null) };
}
