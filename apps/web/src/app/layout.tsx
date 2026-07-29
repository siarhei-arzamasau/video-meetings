import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { Providers } from './providers';

import './globals.css';

export const metadata: Metadata = {
  title: 'Video Meetings',
  description: 'Video meetings platform',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  // suppressHydrationWarning: next-themes writes the theme attributes on <html> before
  // React hydrates, which would otherwise report a mismatch.
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-dvh antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
