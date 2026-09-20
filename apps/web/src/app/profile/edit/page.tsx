import type { Metadata } from 'next';

import { EditProfilePage } from './edit-profile-page';

export const metadata: Metadata = {
  title: 'Edit your profile · Video Meetings',
  description: 'Change the name the people you meet with see.',
};

/**
 * Thin by design, like every other route here: `metadata` has to come from a module Next can
 * read without the client bundle, and the page gates itself on the client because the token
 * lives in `localStorage`.
 */
export default function EditProfileRoute() {
  return <EditProfilePage />;
}
