FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS builder
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/shell/package.json apps/shell/package.json
RUN npm ci --no-audit --no-fund --workspace @haas/hosty-shell
COPY apps/shell apps/shell
ENV NODE_ENV=production
RUN npm run shell:build \
  && npm cache clean --force

FROM node:22-bookworm-slim AS runner
WORKDIR /repo
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

COPY --from=builder /repo/apps/shell/.next/standalone ./
COPY --from=builder /repo/apps/shell/.next/static ./apps/shell/.next/static
COPY --from=builder /repo/apps/shell/public ./apps/shell/public

EXPOSE 3000

CMD ["node", "apps/shell/server.js"]
