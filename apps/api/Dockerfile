# syntax=docker/dockerfile:1
#
# Build context is the repository root:
#   docker build -f apps/api/Dockerfile .

FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS builder
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @repo/shared build
# `build` runs `prisma generate` before `nest build`.
RUN pnpm --filter @repo/api build

FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3001

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nestjs

# Nest has no standalone-output equivalent, so the built workspace is copied as-is.
# Trimming dev dependencies out of this stage is a later optimisation.
COPY --from=builder --chown=nestjs:nodejs /repo/node_modules ./node_modules
COPY --from=builder --chown=nestjs:nodejs /repo/package.json ./package.json
COPY --from=builder --chown=nestjs:nodejs /repo/packages ./packages
COPY --from=builder --chown=nestjs:nodejs /repo/apps/api ./apps/api

USER nestjs
WORKDIR /repo/apps/api
EXPOSE 3001
CMD ["node", "dist/main"]
