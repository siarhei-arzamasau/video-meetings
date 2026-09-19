import { Chip } from '@heroui/react';
import type { MeetingStatus } from '@repo/shared';

/**
 * Exhaustive by type, so adding an entry to `MEETING_STATUSES` is a typecheck error here rather
 * than a chip that renders untinted.
 *
 * Each label is an explicit string rather than a CSS `capitalize` over the raw status: a label
 * is copy, and copy that is really a text-transform cannot be reworded or translated.
 */
const STATUS_CHIP: Record<
  MeetingStatus,
  { color: 'accent' | 'success' | 'default'; variant: 'soft' | 'primary'; label: string }
> = {
  scheduled: { color: 'accent', variant: 'soft', label: 'Scheduled' },
  live: { color: 'success', variant: 'primary', label: 'Live' },
  ended: { color: 'default', variant: 'soft', label: 'Ended' },
};

export function MeetingStatusChip({ status }: { status: MeetingStatus }) {
  const { color, variant, label } = STATUS_CHIP[status];

  return (
    <Chip color={color} variant={variant} size="sm">
      <Chip.Label>{label}</Chip.Label>
    </Chip>
  );
}
