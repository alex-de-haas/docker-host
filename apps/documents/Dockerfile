# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS base
WORKDIR /repo
FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/documents/package.json apps/documents/package.json
COPY packages/app-sdk/package.json packages/app-sdk/package.json
RUN npm ci --workspace @haas/hosty-documents
FROM base AS builder
ENV NODE_ENV=production
COPY --from=deps /repo/node_modules ./node_modules
COPY . .
RUN npm run documents:build
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 HOSTY_APP_CACHE_DIR=/var/cache/hosty-documents
RUN apt-get update && apt-get install -y --no-install-recommends gosu && rm -rf /var/lib/apt/lists/*
COPY --from=builder --chown=node:node /repo/apps/documents/.next/standalone ./
COPY --from=builder --chown=node:node /repo/apps/documents/.next/static ./apps/documents/.next/static
COPY --from=builder --chown=node:node /repo/apps/documents/public ./apps/documents/public
COPY LICENSE /usr/share/licenses/hosty-documents/LICENSE
COPY apps/documents/src/components/reui/LICENSE /usr/share/licenses/hosty-documents/reui.LICENSE
COPY shared/web/fonts/plex-sans-LICENSE.txt /usr/share/licenses/hosty-documents/OFL-IBM-Plex-Sans.txt
COPY shared/web/fonts/jetbrains-mono-LICENSE.txt /usr/share/licenses/hosty-documents/OFL-JetBrains-Mono.txt
COPY apps/documents/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && install -d -o node -g node /var/cache/hosty-documents
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "apps/documents/server.js"]
