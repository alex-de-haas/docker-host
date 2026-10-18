# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS base
WORKDIR /repo
FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/workspaces/package.json apps/workspaces/package.json
COPY packages/app-sdk/package.json packages/app-sdk/package.json
RUN npm ci --workspace @haas/hosty-workspaces
FROM base AS builder
ENV NODE_ENV=production
COPY --from=deps /repo/node_modules ./node_modules
COPY . .
RUN npm run workspaces:build
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --from=builder --chown=node:node /repo/apps/workspaces/.next/standalone ./
COPY --from=builder --chown=node:node /repo/apps/workspaces/.next/static ./apps/workspaces/.next/static
COPY --from=builder --chown=node:node /repo/apps/workspaces/public ./apps/workspaces/public
COPY LICENSE /usr/share/licenses/hosty-workspaces/LICENSE
USER node
EXPOSE 3000
CMD ["node", "apps/workspaces/server.js"]
