import path from 'node:path';

import type { NextConfig } from 'next';

/** The API the page talks to, as the origin `connect-src` names; the same default as the client. */
const API_ORIGIN = new URL(process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001/api')
  .origin;

/**
 * The page's policy, without nonces. The App Router streams its payload in inline scripts and
 * next-themes sets the theme in one before hydration, so `script-src` needs `'unsafe-inline'`
 * until a nonce is threaded through a proxy — which would make every page dynamic. What the
 * policy still closes is the way out: `connect-src` names only this origin and the API, and
 * images come from here or from the blob URLs the app makes itself, so a script that did get in
 * could not send the `localStorage` token anywhere by fetch, XHR, stream or image. Development
 * adds `'unsafe-eval'` for the dev server's own tooling, and only there.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self' data:",
  `connect-src 'self' ${API_ORIGIN}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

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

  // On every route. `frame-ancestors` is what stops clickjacking; `X-Frame-Options` says the
  // same to browsers that predate it. HSTS belongs to whatever terminates TLS.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: CONTENT_SECURITY_POLICY },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
    ];
  },
};

export default nextConfig;
