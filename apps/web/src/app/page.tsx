import type { Metadata } from 'next';

import { HomeDashboard } from './home-dashboard';

export const metadata: Metadata = {
  title: 'Your meetings · Video Meetings',
  description: 'Your latest meetings, and a way to start the next one.',
};

/**
 * Thin by design: `metadata` has to be exported from a module Next can read without running the
 * client bundle, and only the dashboard needs to be interactive.
 *
 * The dashboard gates itself on the client rather than being gated here or in middleware — the
 * token lives in `localStorage`, which the server cannot read. See the app guide.
 */
export default function HomePage() {
  return <HomeDashboard />;
}
