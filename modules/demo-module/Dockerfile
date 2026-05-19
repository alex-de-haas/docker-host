FROM node:22-bookworm-slim AS base
WORKDIR /repo

FROM base AS deps
COPY package.json package-lock.json ./
COPY modules/demo-module/package.json modules/demo-module/package.json
RUN npm ci --workspace @haas/docker-host-demo-module

FROM base AS builder
ENV NODE_ENV=production
COPY --from=deps /repo/node_modules ./node_modules
COPY . .
RUN npm run demo-module:build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV MODULE_ID=com.haas.demo-module
ENV MODULE_VERSION=0.1.0

COPY --from=builder /repo/modules/demo-module/.next/standalone ./
COPY --from=builder /repo/modules/demo-module/.next/static ./modules/demo-module/.next/static
COPY --from=builder /repo/modules/demo-module/public ./modules/demo-module/public

EXPOSE 3000

CMD ["node", "modules/demo-module/server.js"]
