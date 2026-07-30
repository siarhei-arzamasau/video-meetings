/**
 * The product mark: glyph plus name.
 *
 * Shared rather than copied for the same reason the icons are — the auth shell and the
 * signed-in header both draw it, and a second copy is the one that drifts when the mark
 * changes.
 *
 * `isOnDark` exists because the auth brand panel supplies its own fixed dark background in
 * both colour schemes, so the tile there cannot use the themed accent and stay legible.
 */
export function Wordmark({ isOnDark = false }: { isOnDark?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5 text-lg font-semibold tracking-tight">
      <span
        className={`flex size-9 items-center justify-center rounded-xl ${
          isOnDark ? 'bg-white/15 text-white' : 'bg-accent text-accent-foreground'
        }`}
      >
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          className="size-5"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="2.5" y="6" width="12" height="12" rx="3" />
          <path d="m15.5 13 4.2 2.8a1 1 0 0 0 1.55-.83V9.03a1 1 0 0 0-1.55-.83L15.5 11Z" />
        </svg>
      </span>
      Video Meetings
    </span>
  );
}
