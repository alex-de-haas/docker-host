# Base pinned by digest for reproducible builds. To update: re-pin with
#   docker buildx imagetools inspect node:24-bookworm-slim --format '{{.Manifest.Digest}}'
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS builder
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/shell/package.json apps/shell/package.json
COPY packages/app-sdk/package.json packages/app-sdk/package.json
RUN npm ci --no-audit --no-fund --workspace @haas/hosty-shell
COPY apps/shell apps/shell
COPY packages/app-sdk packages/app-sdk
ENV NODE_ENV=production
RUN npm run shell:build \
  && npm cache clean --force

FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS runner
WORKDIR /repo
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# --chown stamps ownership as each layer is written, so the unprivileged `node` user owns the bundle
# without a `chown -R` pass (which would rewrite every file's metadata and duplicate the tree into an
# extra layer). The Shell declares no data mount, so `USER node` needs no privileged startup step.
COPY --from=builder --chown=node:node /repo/apps/shell/.next/standalone ./
COPY --from=builder --chown=node:node /repo/apps/shell/.next/static ./apps/shell/.next/static
COPY --from=builder --chown=node:node /repo/apps/shell/public ./apps/shell/public
# Next's image optimizer writes into <distDir>/cache at runtime.
RUN install -d -o node -g node /repo/apps/shell/.next/cache

USER node
EXPOSE 3000

CMD ["node", "apps/shell/server.js"]
