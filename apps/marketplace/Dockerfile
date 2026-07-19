# syntax=docker/dockerfile:1
# Hosty Marketplace standalone Next.js image. Built from the repository root so the workspace
# lockfile and pinned framework override are applied consistently.
FROM node:24-bookworm-slim AS base
WORKDIR /repo

FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/marketplace/package.json apps/marketplace/package.json
COPY packages/app-sdk/package.json packages/app-sdk/package.json
RUN npm ci --workspace @haas/hosty-marketplace

FROM base AS builder
ENV NODE_ENV=production
COPY --from=deps /repo/node_modules ./node_modules
COPY . .
RUN npm run marketplace:build

FROM node:24-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

COPY --from=builder /repo/apps/marketplace/.next/standalone ./
COPY --from=builder /repo/apps/marketplace/.next/static ./apps/marketplace/.next/static
COPY --from=builder /repo/apps/marketplace/public ./apps/marketplace/public

EXPOSE 3000

CMD ["node", "apps/marketplace/server.js"]
