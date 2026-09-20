import type { Metadata } from 'next';

import { ProfilePage } from './profile-page';

export const metadata: Metadata = {
  title: 'Your profile · Video Meetings',
  description: 'The account you are signed in with, and the way to change it.',
};

/**
 * Thin by design, like the home and meeting pages: `metadata` has to come from a module Next
 * can read without the client bundle, and the page gates itself on the client because the
 * token lives in `localStorage`.
 */
export default function ProfileRoute() {
  return <ProfilePage />;
}
