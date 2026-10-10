'use client';

import { Button, Spinner } from '@heroui/react';

import { CloseIcon, RetryIcon } from '@/components/icons';
import type { DigestActionLine } from '@/lib/meeting-digest-action';

interface DigestActionButtonsProps {
  /** The control this reader is offered; `null` draws no button for it. */
  action: DigestActionLine | null;
  isRequesting: boolean;
  /** An error is on show, so there is something to dismiss. */
  hasError: boolean;
  onRequest(): void;
  onDismiss(): void;
}

/**
 * "Retry", and Dismiss while the last request's failure is on show — the row's own pair, in
 * the row's own sizes, so the two Retry buttons a page can hold look like the same kind of
 * thing.
 *
 * **Secondary, not primary.** The page already has its one primary action, "Add file", and a
 * digest is a consequence of the files rather than the reason the page is open.
 *
 * Disabled with a spinner while its request is on its way: one press is one generation, and
 * every generation is paid for.
 */
export function DigestActionButtons({
  action,
  isRequesting,
  hasError,
  onRequest,
  onDismiss,
}: DigestActionButtonsProps) {
  return (
    <>
      {action !== null && (
        <Button variant="secondary" size="sm" isDisabled={isRequesting} onPress={onRequest}>
          {isRequesting && <Spinner color="current" size="sm" aria-hidden="true" />}
          {!isRequesting && <RetryIcon />}
          {action.label}
        </Button>
      )}
      {hasError && (
        <Button variant="tertiary" size="sm" onPress={onDismiss}>
          <CloseIcon />
          Dismiss
        </Button>
      )}
    </>
  );
}
