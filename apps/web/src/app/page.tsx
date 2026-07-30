import { Card, buttonVariants } from '@heroui/react';
import Link from 'next/link';

import { ThemeToggle } from '@/components/theme-toggle';
import { getApiBaseUrl } from '@/lib/api-client';

// A Server Component: HeroUI v3 renders without a 'use client' boundary.
export default function HomePage() {
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <Card.Header>
          <Card.Title>Video Meetings</Card.Title>
          <Card.Description>
            Monorepo scaffold. Registration is the first feature wired end to end; everything else
            still proves only that HeroUI, Tailwind, and theming work.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          <p className="text-sm opacity-70">
            API base URL: <code>{getApiBaseUrl()}</code>
          </p>
        </Card.Content>
        <Card.Footer className="flex gap-3">
          {/* An anchor, not a Button: this navigates, and Next's client-side routing needs a
              real link to hook. `buttonVariants` keeps it looking like the rest. */}
          <Link href="/register" className={buttonVariants({ variant: 'primary' })}>
            Create an account
          </Link>
          <ThemeToggle />
        </Card.Footer>
      </Card>
    </main>
  );
}
