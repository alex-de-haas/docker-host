# Base pinned by digest for reproducible builds. To update: re-pin with
#   docker buildx imagetools inspect node:24-bookworm-slim --format '{{.Manifest.Digest}}'
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS builder
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/desktop/package.json apps/desktop/package.json
COPY packages/app-sdk/package.json packages/app-sdk/package.json
RUN npm ci --no-audit --no-fund --workspace @haas/hosty-desktop
COPY apps/desktop apps/desktop
COPY shared/web shared/web
COPY packages/app-sdk packages/app-sdk
ENV NODE_ENV=production
RUN npm run desktop:build \
  && npm cache clean --force

FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS runner
WORKDIR /repo
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# --chown stamps ownership as each layer is written, so the unprivileged `node` user owns the bundle
# without a `chown -R` pass (which would rewrite every file's metadata and duplicate the tree into an
# extra layer). The Desktop declares no data mount, so `USER node` needs no privileged startup step.
COPY --from=builder --chown=node:node /repo/apps/desktop/.next/standalone ./
COPY --from=builder --chown=node:node /repo/apps/desktop/.next/static ./apps/desktop/.next/static
COPY --from=builder --chown=node:node /repo/apps/desktop/public ./apps/desktop/public
# Next's image optimizer writes into <distDir>/cache at runtime.
RUN install -d -o node -g node /repo/apps/desktop/.next/cache

USER node
EXPOSE 3000

CMD ["node", "apps/desktop/server.js"]
