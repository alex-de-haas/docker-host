FROM node:24-bookworm-slim AS base
WORKDIR /repo

FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/demo-app/package.json apps/demo-app/package.json
RUN npm ci --workspace @haas/hosty-demo-app

FROM base AS builder
ENV NODE_ENV=production
COPY --from=deps /repo/node_modules ./node_modules
COPY . .
RUN npm run demo-app:build

FROM node:24-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV HOSTY_APP_ID=com.haas.demo-app
# Keep in step with apps/demo-app/manifest.json + package.json (enforced by scripts/check-versions.mjs).
ENV HOSTY_APP_VERSION=0.4.2

COPY --from=builder /repo/apps/demo-app/.next/standalone ./
COPY --from=builder /repo/apps/demo-app/.next/static ./apps/demo-app/.next/static
COPY --from=builder /repo/apps/demo-app/public ./apps/demo-app/public

EXPOSE 3000

CMD ["node", "apps/demo-app/server.js"]
