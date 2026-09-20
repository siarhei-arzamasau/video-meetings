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
      {/* The page paints its own background. Without these two tokens html, body and main are
          all transparent, and the colour you see is the browser's root canvas following
          `color-scheme` — which happens to match in a plain Chrome window and does not in an
          embedded one, where light mode became a dark page behind a white card. */}
      <body className="bg-background text-foreground min-h-dvh antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
