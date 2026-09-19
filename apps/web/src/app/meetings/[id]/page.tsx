import type { Metadata } from 'next';

import { MeetingPage } from './meeting-page';

export const metadata: Metadata = {
  title: 'Meeting · Video Meetings',
  description: 'One meeting: when it is, who is hosting, and its files.',
};

/**
 * Thin by design, like the home page: `metadata` has to come from a module Next can read
 * without the client bundle, and the page gates itself on the client because the token lives
 * in `localStorage`. The id is read by the client component from `useParams`, so nothing
 * here depends on the route params either.
 */
export default function MeetingRoute() {
  return <MeetingPage />;
}
