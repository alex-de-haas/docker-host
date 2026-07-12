# syntax=docker/dockerfile:1
# Hosty Telemetry UI standalone Next.js image. Built from the repository root so the workspace
# lockfile and pinned framework override are applied consistently. Runs as the `ui` service of the
# hosty.telemetry app, alongside the collector and the .NET telemetry backend.
FROM node:24-bookworm-slim AS base
WORKDIR /repo

FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/telemetry-ui/package.json apps/telemetry-ui/package.json
RUN npm ci --workspace @haas/hosty-telemetry-ui

FROM base AS builder
ENV NODE_ENV=production
COPY --from=deps /repo/node_modules ./node_modules
COPY . .
RUN npm run telemetry-ui:build

FROM node:24-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

COPY --from=builder /repo/apps/telemetry-ui/.next/standalone ./
COPY --from=builder /repo/apps/telemetry-ui/.next/static ./apps/telemetry-ui/.next/static
COPY --from=builder /repo/apps/telemetry-ui/public ./apps/telemetry-ui/public

EXPOSE 3000

CMD ["node", "apps/telemetry-ui/server.js"]
