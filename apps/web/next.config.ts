import path from 'node:path';

import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // Produces .next/standalone, which the Dockerfile copies as the whole runtime.
  output: 'standalone',

  // Without this, file tracing stops at apps/web and misses workspace packages.
  outputFileTracingRoot: path.resolve(process.cwd(), '../..'),

  transpilePackages: ['@repo/shared'],

  // `/register` was the sign-up page before the auth pages moved under `/auth`. A 308 keeps
  // links that predate the move working without a route file that exists only to redirect.
  async redirects() {
    return [{ source: '/register', destination: '/auth/register', permanent: true }];
  },
};

export default nextConfig;
