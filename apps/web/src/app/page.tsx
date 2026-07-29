import { Button, Card } from '@heroui/react';

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
            Monorepo scaffold. No features yet — this page exists to prove the HeroUI, Tailwind, and
            theming wiring works.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          <p className="text-sm opacity-70">
            API base URL: <code>{getApiBaseUrl()}</code>
          </p>
        </Card.Content>
        <Card.Footer className="flex gap-3">
          <Button variant="primary">Get started</Button>
          <ThemeToggle />
        </Card.Footer>
      </Card>
    </main>
  );
}
