# syntax=docker/dockerfile:1
# Hosty Marketplace standalone Next.js image. Built from the repository root so the workspace
# lockfile and pinned framework override are applied consistently.
#
# Base pinned by digest for reproducible builds. To update: re-pin with
#   docker buildx imagetools inspect node:24-bookworm-slim --format '{{.Manifest.Digest}}'
FROM node:24-bookworm-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7 AS base
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

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# gosu lets the entrypoint drop from root to the unprivileged `node` user after fixing data-dir
# ownership (see docker-entrypoint.sh).
RUN apt-get update \
  && apt-get install -y --no-install-recommends gosu \
  && rm -rf /var/lib/apt/lists/*

# --chown stamps ownership as each layer is written, so `node` owns the bundle without a `chown -R`
# pass (which would rewrite every file's metadata and duplicate the tree into an extra layer).
COPY --from=builder --chown=node:node /repo/apps/marketplace/.next/standalone ./
COPY --from=builder --chown=node:node /repo/apps/marketplace/.next/static ./apps/marketplace/.next/static
COPY --from=builder --chown=node:node /repo/apps/marketplace/public ./apps/marketplace/public
COPY apps/marketplace/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# Next's image optimizer writes into <distDir>/cache; /var/lib/hosty-marketplace is the manifest mount.
# The cache is mode 1777 because the entrypoint may run the server as the data mount's owner rather
# than `node` (see docker-entrypoint.sh) — sticky like /tmp, and it holds only derived, non-secret output.
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
  && install -d -o node -g node -m 1777 /app/apps/marketplace/.next/cache \
  && install -d -o node -g node /var/lib/hosty-marketplace

EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "apps/marketplace/server.js"]
