FROM node:22-bookworm-slim AS base
WORKDIR /repo

FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/host/package.json apps/host/package.json
RUN npm ci --workspace @haas/docker-host-app

FROM base AS builder
ENV NODE_ENV=production
COPY --from=deps /repo/node_modules ./node_modules
COPY . .
RUN npm run host:build

FROM node:22-bookworm-slim AS runner
WORKDIR /repo
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

COPY package.json package-lock.json ./
COPY apps/host/package.json apps/host/package.json
RUN npm ci --workspace @haas/docker-host-app --omit=dev

COPY --from=builder /repo/apps/host/.next ./apps/host/.next
COPY --from=builder /repo/apps/host/public ./apps/host/public
COPY --from=builder /repo/apps/host/scripts ./apps/host/scripts
COPY --from=builder /repo/apps/host/scripts /app/scripts
COPY --from=builder /repo/apps/host/server.mjs ./apps/host/server.mjs
COPY --from=builder /repo/apps/host/next.config.ts ./apps/host/next.config.ts

EXPOSE 3000

CMD ["node", "apps/host/server.mjs", "--production"]
