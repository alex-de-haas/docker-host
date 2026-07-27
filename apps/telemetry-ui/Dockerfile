# syntax=docker/dockerfile:1
# Hosty Telemetry UI standalone Next.js image. Built from the repository root so the workspace
# lockfile and pinned framework override are applied consistently. Runs as the `ui` service of the
# hosty.telemetry app, alongside the collector and the .NET telemetry backend.
#
# Base pinned by digest for reproducible builds. To update: re-pin with
#   docker buildx imagetools inspect node:24-bookworm-slim --format '{{.Manifest.Digest}}'
FROM node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS base
WORKDIR /repo

FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/telemetry-ui/package.json apps/telemetry-ui/package.json
COPY packages/app-sdk/package.json packages/app-sdk/package.json
RUN npm ci --workspace @haas/hosty-telemetry-ui

FROM base AS builder
ENV NODE_ENV=production
COPY --from=deps /repo/node_modules ./node_modules
COPY . .
RUN npm run telemetry-ui:build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# --chown stamps ownership as each layer is written, so the unprivileged `node` user owns the bundle
# without a `chown -R` pass (which would rewrite every file's metadata and duplicate the tree into an
# extra layer). The `ui` service declares no data mount — the telemetry app's mount belongs to the
# collector — so `USER node` needs no privileged startup step.
COPY --from=builder --chown=node:node /repo/apps/telemetry-ui/.next/standalone ./
COPY --from=builder --chown=node:node /repo/apps/telemetry-ui/.next/static ./apps/telemetry-ui/.next/static
COPY --from=builder --chown=node:node /repo/apps/telemetry-ui/public ./apps/telemetry-ui/public
# Next's image optimizer writes into <distDir>/cache at runtime.
RUN install -d -o node -g node /app/apps/telemetry-ui/.next/cache

USER node
EXPOSE 3000

CMD ["node", "apps/telemetry-ui/server.js"]
