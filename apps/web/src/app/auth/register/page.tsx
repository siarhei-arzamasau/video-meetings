import type { Metadata } from 'next';

import { RegisterCard } from './register-card';

export const metadata: Metadata = {
  title: 'Create your account · Video Meetings',
  description: 'Sign up for Video Meetings with an email address and a password.',
};

// The two-column shell, brand panel, and theme toggle come from `../layout.tsx`.
export default function RegisterPage() {
  return <RegisterCard />;
}
