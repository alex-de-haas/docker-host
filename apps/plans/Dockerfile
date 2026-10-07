# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS base
WORKDIR /repo
FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/plans/package.json apps/plans/package.json
COPY packages/app-sdk/package.json packages/app-sdk/package.json
RUN npm ci --workspace @haas/hosty-plans
FROM base AS builder
ENV NODE_ENV=production
COPY --from=deps /repo/node_modules ./node_modules
COPY . .
RUN npm run plans:build
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 HOSTY_APP_CACHE_DIR=/var/cache/hosty-plans
RUN apt-get update && apt-get install -y --no-install-recommends gosu && rm -rf /var/lib/apt/lists/*
COPY --from=builder --chown=node:node /repo/apps/plans/.next/standalone ./
COPY --from=builder --chown=node:node /repo/apps/plans/.next/static ./apps/plans/.next/static
COPY --from=builder --chown=node:node /repo/apps/plans/public ./apps/plans/public
COPY LICENSE /usr/share/licenses/hosty-plans/LICENSE
COPY apps/plans/src/components/reui/LICENSE /usr/share/licenses/hosty-plans/reui.LICENSE
COPY apps/plans/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && install -d -o node -g node /var/cache/hosty-plans
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "apps/plans/server.js"]
