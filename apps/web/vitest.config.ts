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
    // Every core, not the default of one fewer: the suite is short enough that process
    // start-up dominates, so the win is small, but so is the cost of asking for it. Jest in
    // the API is set the same way. Lower it per run with `--maxWorkers=4` on a machine that
    // is busy with something else — the pre-commit hook runs this suite too.
    maxWorkers: '100%',
  },
});
