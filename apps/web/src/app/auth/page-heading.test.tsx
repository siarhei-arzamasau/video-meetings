import { Card } from '@heroui/react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { renderPageHeading } from './page-heading';

afterEach(cleanup);

describe('renderPageHeading', () => {
  // Left to itself a card's title is an `h3`, and on the sign-in and sign-up pages the only
  // `h1` was in a panel that is hidden below `lg`.
  it('draws a card title as the page’s one top-level heading, keeping the title’s own classes', () => {
    render(
      <Card>
        <Card.Header>
          <Card.Title className="text-2xl" render={renderPageHeading}>
            Welcome back
          </Card.Title>
        </Card.Header>
      </Card>,
    );

    const heading = screen.getByRole('heading', { level: 1, name: 'Welcome back' });

    expect(heading.classList.contains('card__title')).toBe(true);
    expect(heading.classList.contains('text-2xl')).toBe(true);
    expect(screen.queryAllByRole('heading', { level: 3 })).toEqual([]);
  });
});
