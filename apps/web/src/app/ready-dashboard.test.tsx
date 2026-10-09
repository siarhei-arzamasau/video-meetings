import type { Meeting, User } from '@repo/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ReadyDashboard } from './ready-dashboard';

const USER: User = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'ada@example.com',
  displayName: 'Ada Lovelace',
  avatarVersion: 0,
  createdAt: '2026-07-30T09:00:00.000Z',
};

const MEETING: Meeting = {
  id: '44444444-4444-4444-8444-444444444444',
  title: 'Engine review',
  scheduledAt: '2026-10-01T10:00:00.000Z',
  status: 'scheduled',
  hostId: USER.id,
  participantIds: [],
};

/** The routes a link on the dashboard may point at: a meeting's own page, and nothing else. */
const MEETING_PAGE = /^\/meetings\/[0-9a-f-]{36}$/;

afterEach(cleanup);

describe('ReadyDashboard', () => {
  // Both of its "New meeting" links used to point at `/meetings/new`, a route the app does not
  // have: the meeting page took `new` for an id and answered "Page not found".
  it('offers a new account no link, because there is no page to create a meeting on', () => {
    render(<ReadyDashboard user={USER} meetings={[]} total={0} />);

    expect(screen.getByText('No meetings yet')).toBeTruthy();
    expect(screen.queryAllByRole('link')).toEqual([]);
  });

  it('links each meeting to its own page, and to nothing else', () => {
    render(<ReadyDashboard user={USER} meetings={[MEETING]} total={1} />);

    const destinations = screen.getAllByRole('link').map((link) => link.getAttribute('href'));

    expect(destinations).toEqual([`/meetings/${MEETING.id}`]);
    expect(destinations.every((href) => MEETING_PAGE.test(href ?? ''))).toBe(true);
  });
});
