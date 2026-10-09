import type { JSX, ReactElement } from 'react';

/**
 * A `Card.Title` drawn as the page's `h1`: pass it as the title's `render`.
 *
 * HeroUI renders a card's title as an `h3`, which is right for a card among others and wrong
 * here, where the card is the page: its title is what the page is called. The only `h1` used
 * to be the brand panel's tagline, and that panel is hidden below `lg` — so a phone had a page
 * with no top-level heading, and a desktop one whose `h1` was a slogan. Shared so the sign-in
 * and sign-up cards cannot end up with different outlines.
 */
export function renderPageHeading({
  children,
  ...props
}: JSX.IntrinsicElements['h3']): ReactElement {
  return <h1 {...props}>{children}</h1>;
}
