# syntax=docker/dockerfile:1
#
# Build context is the repository root:
#   docker build -f apps/web/Dockerfile .

FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS builder
# NEXT_PUBLIC_* values are inlined at build time, so they must arrive as build args.
ARG NEXT_PUBLIC_API_URL=http://localhost:3001/api
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @repo/shared build
RUN pnpm --filter @repo/web build

FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

# `output: 'standalone'` plus outputFileTracingRoot emits a self-contained tree rooted at
# the monorepo, so apps/web/server.js is the entrypoint once it is unpacked here.
COPY --from=builder --chown=nextjs:nodejs /repo/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /repo/apps/web/public ./apps/web/public

USER nextjs
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
