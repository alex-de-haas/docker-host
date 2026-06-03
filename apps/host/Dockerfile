FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS builder
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/host/package.json apps/host/package.json
RUN npm ci --no-audit --no-fund --workspace @haas/docker-host-app
COPY . .
ENV NODE_ENV=production
RUN npm run build --workspace @haas/docker-host-app \
  && npm cache clean --force

FROM node:22-bookworm-slim AS prod-deps
WORKDIR /repo
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY apps/host/package.json apps/host/package.json
RUN npm ci --no-audit --no-fund --omit=dev --workspace @haas/docker-host-app \
  && npm cache clean --force

FROM node:22-bookworm-slim AS runner
WORKDIR /repo
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

COPY --from=builder /repo/apps/host/.next/standalone ./
COPY --from=builder /repo/apps/host/.next/static ./apps/host/.next/static
COPY --from=prod-deps /repo/node_modules/@img ./node_modules/@img
COPY --from=prod-deps /repo/node_modules/@next ./node_modules/@next
COPY --from=prod-deps /repo/node_modules/jose ./node_modules/jose
COPY --from=prod-deps /repo/node_modules/next ./node_modules/next
COPY --from=prod-deps /repo/node_modules/sharp ./node_modules/sharp
COPY --from=prod-deps /repo/node_modules/ssh2 ./node_modules/ssh2
COPY --from=builder /repo/apps/host/public ./apps/host/public
COPY --from=builder /repo/apps/host/scripts ./apps/host/scripts
COPY --from=builder /repo/apps/host/scripts /app/scripts
COPY --from=builder /repo/apps/host/server.mjs ./apps/host/server.mjs
COPY --from=builder /repo/apps/host/src/lib/module-identity.mjs ./apps/host/src/lib/module-identity.mjs
COPY --from=builder /repo/apps/host/src/lib/trusted-proxy.mjs ./apps/host/src/lib/trusted-proxy.mjs
COPY --from=builder /repo/apps/host/next.config.ts ./apps/host/next.config.ts
COPY --from=builder /repo/apps/demo-app/manifest.json ./apps/demo-app/manifest.json

EXPOSE 3000

CMD ["node", "apps/host/server.mjs", "--production"]
