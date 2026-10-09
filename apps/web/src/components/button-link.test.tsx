import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ButtonLink } from './button-link';

afterEach(cleanup);

describe('ButtonLink', () => {
  it('is a link to its destination, drawn as a primary button', () => {
    render(<ButtonLink href="/profile/edit">Edit profile</ButtonLink>);

    const link = screen.getByRole('link', { name: 'Edit profile' });

    expect(link.getAttribute('href')).toBe('/profile/edit');
    expect(link.classList.contains('button')).toBe(true);
    expect(link.classList.contains('button--primary')).toBe(true);
  });

  // The reason the component exists: a variant function alone leaves an anchor with the
  // button's `outline-none` and no ring, so keyboard focus on it is invisible.
  it('asks for the keyboard focus ring HeroUI 3.2.2 does not give an anchor', () => {
    render(<ButtonLink href="/">Continue</ButtonLink>);

    const link = screen.getByRole('link', { name: 'Continue' });

    expect(link.classList.contains('focus-visible:focus-ring')).toBe(true);
  });

  it('takes a variant, a width, and classes of its own without losing the ring', () => {
    render(
      <ButtonLink href="/" variant="secondary" fullWidth className="w-fit">
        Back
      </ButtonLink>,
    );

    const link = screen.getByRole('link', { name: 'Back' });

    expect(link.classList.contains('button--secondary')).toBe(true);
    expect(link.classList.contains('button--full-width')).toBe(true);
    expect(link.classList.contains('w-fit')).toBe(true);
    expect(link.classList.contains('focus-visible:focus-ring')).toBe(true);
  });
});
