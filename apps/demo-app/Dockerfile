# syntax=docker/dockerfile:1
# Base pinned by digest for reproducible builds. To update: re-pin with
#   docker buildx imagetools inspect node:24-bookworm-slim --format '{{.Manifest.Digest}}'
FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS base
WORKDIR /repo

FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/demo-app/package.json apps/demo-app/package.json
COPY packages/app-sdk/package.json packages/app-sdk/package.json
RUN npm ci --workspace @haas/hosty-demo-app

FROM base AS builder
ENV NODE_ENV=production
COPY --from=deps /repo/node_modules ./node_modules
COPY . .
RUN npm run demo-app:build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV HOSTY_APP_ID=com.haas.demo-app
# Keep in step with apps/demo-app/manifest.json + package.json (enforced by scripts/check-versions.mjs).
ENV HOSTY_APP_VERSION=0.7.1
# gosu lets the entrypoint drop from root to the unprivileged `node` user after fixing data-dir
# ownership (see docker-entrypoint.sh).
RUN apt-get update \
  && apt-get install -y --no-install-recommends gosu \
  && rm -rf /var/lib/apt/lists/*

# --chown stamps ownership as each layer is written, so `node` owns the bundle without a `chown -R`
# pass (which would rewrite every file's metadata and duplicate the tree into an extra layer).
COPY --from=builder --chown=node:node /repo/apps/demo-app/.next/standalone ./
COPY --from=builder --chown=node:node /repo/apps/demo-app/.next/static ./apps/demo-app/.next/static
COPY --from=builder --chown=node:node /repo/apps/demo-app/public ./apps/demo-app/public
COPY apps/demo-app/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# Next's image optimizer writes into <distDir>/cache; /app/data is the `backend` service's mount.
# The cache is mode 1777 because the entrypoint may run the server as the data mount's owner rather
# than `node` (see docker-entrypoint.sh) — sticky like /tmp, and it holds only derived, non-secret output.
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
  && install -d -o node -g node -m 1777 /app/apps/demo-app/.next/cache \
  && install -d -o node -g node /app/data

EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "apps/demo-app/server.js"]
