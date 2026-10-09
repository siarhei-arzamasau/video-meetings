import { buttonVariants } from '@heroui/react';
import Link from 'next/link';
import type { ComponentProps } from 'react';

type ButtonLook = NonNullable<Parameters<typeof buttonVariants>[0]>;

type ButtonLinkProps = ComponentProps<typeof Link> & Pick<ButtonLook, 'variant' | 'fullWidth'>;

/**
 * The ring a HeroUI `Button` shows under keyboard focus, asked for by name.
 *
 * `.button` removes the outline, and HeroUI 3.2.2 attaches its ring to two selectors:
 * `:focus-visible:not(:focus)`, which nothing can match, and `data-focus-visible`, which only
 * React Aria sets. A plain anchor therefore gets neither, and tabbing to one shows nothing at
 * all. `focus-ring` is the utility the button's own rule applies, so the two cannot drift.
 * Fixed upstream in 3.2.5; delete this constant with that upgrade.
 */
const KEYBOARD_FOCUS_RING = 'focus-visible:focus-ring';

/**
 * A link drawn as a HeroUI button.
 *
 * An anchor, not a `Button`: it navigates, and Next's client-side routing needs a real link to
 * hook. `buttonVariants` keeps it looking like the buttons beside it; this component exists so
 * that every such link also carries the focus ring a variant function alone leaves out.
 */
export function ButtonLink({
  variant = 'primary',
  fullWidth,
  className,
  ...linkProps
}: ButtonLinkProps) {
  const classNames = [buttonVariants({ variant, fullWidth }), KEYBOARD_FOCUS_RING, className];

  return <Link {...linkProps} className={classNames.filter(Boolean).join(' ')} />;
}
