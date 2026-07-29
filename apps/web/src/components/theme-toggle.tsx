'use client';

import { Button } from '@heroui/react';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // The resolved theme is only known on the client, so the label waits for mount
  // rather than rendering a value the server could not have produced.
  useEffect(() => {
    setMounted(true);
  }, []);

  const isDark = resolvedTheme === 'dark';

  return (
    <Button
      variant="secondary"
      aria-label="Toggle color theme"
      onPress={() => {
        setTheme(isDark ? 'light' : 'dark');
      }}
    >
      {mounted ? (isDark ? 'Light theme' : 'Dark theme') : 'Theme'}
    </Button>
  );
}
