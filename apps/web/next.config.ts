import path from 'node:path';

import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // Produces .next/standalone, which the Dockerfile copies as the whole runtime.
  output: 'standalone',

  // Without this, file tracing stops at apps/web and misses workspace packages.
  outputFileTracingRoot: path.resolve(process.cwd(), '../..'),

  transpilePackages: ['@repo/shared'],
};

export default nextConfig;
