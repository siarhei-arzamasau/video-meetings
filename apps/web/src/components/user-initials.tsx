import { initialsOf } from '@/lib/user';

/**
 * The circle that stands for a person: one or two letters taken from their display name.
 *
 * `aria-hidden`, always. Both call sites render the name itself next to it, so announcing the
 * initials would read the same person twice — and a screen reader spelling out "AL" next to
 * "Ada Lovelace" tells the listener nothing the name did not.
 *
 * `UserAvatar` is what pages draw and this is what it falls back to, so it is reached only
 * through that component rather than imported page by page: the header and the profile must
 * not be able to disagree about what a person's circle looks like.
 */
export function UserInitials({
  displayName,
  size = 'sm',
}: {
  displayName: string;
  size?: 'sm' | 'lg';
}) {
  return (
    <span
      aria-hidden="true"
      className={`bg-accent/10 text-accent flex shrink-0 items-center justify-center rounded-full font-semibold ${
        size === 'lg' ? 'size-16 text-xl' : 'size-8 text-xs'
      }`}
    >
      {initialsOf(displayName)}
    </span>
  );
}
