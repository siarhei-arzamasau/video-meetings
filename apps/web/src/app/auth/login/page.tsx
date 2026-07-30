import type { Metadata } from 'next';

import { LoginCard } from './login-card';

export const metadata: Metadata = {
  title: 'Sign in · Video Meetings',
  description: 'Sign in to Video Meetings with your email address and password.',
};

// The two-column shell, brand panel, and theme toggle come from `../layout.tsx`.
export default function LoginPage() {
  return <LoginCard />;
}
