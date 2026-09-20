import path from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    // Four, not one per core: a test run is something a developer starts on a machine that is
    // doing other things, and nine jsdom forks on an 18-core laptop are a noticeable stall for
    // no gain on a suite that finishes in under a second. Jest in the API is capped the same
    // way; both are raised per run with `--maxWorkers` when a CI box has the cores to spare.
    maxWorkers: 4,
  },
});
