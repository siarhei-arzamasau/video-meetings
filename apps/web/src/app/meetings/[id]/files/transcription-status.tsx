'use client';

import { Chip, Link, Spinner, Tooltip } from '@heroui/react';

import { WarningIcon } from '@/components/icons';
import type { TranscriptionPresentation } from '@/lib/meeting-files';

interface TranscriptionStatusProps {
  transcription: TranscriptionPresentation;
  /** A transcript is on its way to a tab: the link waits rather than opening a second one. */
  isOpening: boolean;
  onOpen(): void;
}

/**
 * Where a recording's transcription stands, in the row's status slot: the chips the file's
 * own status uses, and a link once there is a transcript to open. Nothing at all for a file
 * that is not a recording.
 *
 * The link has no `href` — the transcript route needs the bearer header — so React Aria
 * renders it as `role="link"` and `onOpen` runs inside the press, which is what lets the
 * caller open its tab before a popup blocker would mind.
 */
export function TranscriptionStatus({
  transcription,
  isOpening,
  onOpen,
}: TranscriptionStatusProps) {
  switch (transcription.kind) {
    case 'none':
      return null;
    case 'queued':
      return (
        <Chip color="default" variant="soft" size="sm">
          <Chip.Label>Queued for transcription</Chip.Label>
        </Chip>
      );
    case 'transcribing':
      return (
        <Chip color="default" variant="soft" size="sm">
          <Spinner size="sm" aria-hidden="true" />
          <Chip.Label>Transcribing…</Chip.Label>
        </Chip>
      );
    case 'transcribed':
      return (
        // `min-h-6`: a line of small text is 20px tall, under the 24px a pointer target needs.
        <Link className="min-h-6 text-sm" isDisabled={isOpening} onPress={onOpen}>
          Open transcript
          <span className="sr-only"> (opens in a new tab)</span>
          <Link.Icon />
        </Link>
      );
    case 'failed':
      return <FailedChip reason={transcription.reason} />;
  }
}

/** The row's own failure idiom: a warning chip whose tooltip carries the reason. */
function FailedChip({ reason }: { reason: string }) {
  return (
    <Tooltip delay={0}>
      <Tooltip.Trigger
        tabIndex={0}
        className="focus-visible:ring-focus rounded-full outline-none focus-visible:ring-2"
      >
        <Chip color="warning" variant="soft" size="sm">
          <WarningIcon />
          <Chip.Label>Transcription failed</Chip.Label>
        </Chip>
      </Tooltip.Trigger>
      <Tooltip.Content>
        <Tooltip.Arrow />
        {reason}
      </Tooltip.Content>
    </Tooltip>
  );
}
