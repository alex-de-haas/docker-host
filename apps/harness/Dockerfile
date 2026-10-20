FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/harness/package.json apps/harness/package.json
COPY apps/harness/web/package.json apps/harness/web/package.json
COPY packages/app-sdk/package.json packages/app-sdk/package.json
RUN npm ci --no-audit --no-fund --workspace @haas/hosty-harness --workspace @haas/hosty-harness-web --workspace @hosty-sdk/app
COPY apps/harness apps/harness
COPY packages/app-sdk packages/app-sdk
COPY shared shared
RUN npm run harness:build-web

FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
ENV NODE_ENV=production HOME=/tmp
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/app-sdk ./packages/app-sdk
COPY --from=build /repo/apps/harness ./apps/harness
COPY --from=build /repo/shared ./shared
# Core supplies the host's numeric identity and the app's own data/cache mounts. Agent tools and
# source live in the separate worker; this image contains only the trusted coordinator and UI.
USER 1000:1000
EXPOSE 3400
WORKDIR /repo/apps/harness
CMD ["node", "--import", "tsx", "src/main.ts"]
