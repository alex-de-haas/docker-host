FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS dependencies
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/harness/package.json apps/harness/package.json
COPY apps/harness/web/package.json apps/harness/web/package.json
COPY packages/app-sdk/package.json packages/app-sdk/package.json
RUN npm ci --no-audit --no-fund --workspace @haas/hosty-harness --workspace @haas/hosty-harness-web --workspace @hosty-sdk/app

FROM dependencies AS web
COPY apps/harness/web/next.config.ts apps/harness/web/tsconfig.json apps/harness/web/postcss.config.mjs apps/harness/web/
COPY apps/harness/web/src apps/harness/web/src
COPY apps/harness/web/public apps/harness/web/public
COPY apps/harness/shared apps/harness/shared
COPY packages/app-sdk/src packages/app-sdk/src
COPY shared/web shared/web
# These shared DTOs and pure presentation helpers are the web's complete backend import closure.
# API-only changes keep the static export cached; Next still checks every shipped source type.
COPY apps/harness/src/agent-providers/decision-identity.ts apps/harness/src/agent-providers/history-content.ts apps/harness/src/agent-providers/transcript-source.ts apps/harness/src/agent-providers/
COPY apps/harness/src/feedback/presentation.ts apps/harness/src/feedback/workspace.ts apps/harness/src/feedback/
COPY apps/harness/src/harness/activity.ts apps/harness/src/harness/context-mcp.ts apps/harness/src/harness/context-sources.ts apps/harness/src/harness/context-usage.ts apps/harness/src/harness/provider-usage.ts apps/harness/src/harness/
COPY apps/harness/src/profiles/types.ts apps/harness/src/profiles/
COPY apps/harness/src/prompt-templates/types.ts apps/harness/src/prompt-templates/
COPY apps/harness/src/sessions/transcript-edit-types.ts apps/harness/src/sessions/
COPY apps/harness/src/subagents/types.ts apps/harness/src/subagents/
ENV NEXT_TELEMETRY_DISABLED=1 HOSTY_HARNESS_BOUNDED_BUILD=1
RUN npm run build --workspace @haas/hosty-harness-web -- --webpack

FROM dependencies AS api
COPY apps/harness/src apps/harness/src
COPY apps/harness/shared apps/harness/shared
COPY apps/harness/scripts apps/harness/scripts
COPY packages/app-sdk/src packages/app-sdk/src
COPY scripts/npm-workspace.mjs scripts/npm-workspace.mjs
COPY packages/agent-provider-runtime/scripts/generation-use.mjs packages/agent-provider-runtime/scripts/generation-use.mjs
RUN node apps/harness/scripts/build-local.mjs --api-only

FROM api AS package
COPY --from=web /repo/apps/harness/web/out-build apps/harness/web/out-build
RUN node apps/harness/scripts/stage-runtime.mjs /runtime

FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS runtime-dependencies
WORKDIR /runtime
COPY --from=package /runtime/package.json /runtime/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production HOME=/tmp HOSTY_HARNESS_WEB_OUTPUT=/app/web
COPY --from=runtime-dependencies --chown=node:node /runtime/node_modules ./node_modules
COPY --from=package --chown=node:node /runtime/package.json ./package.json
COPY --from=package --chown=node:node /runtime/api.mjs ./api.mjs
COPY --from=package --chown=node:node /runtime/web ./web
# Native execution and project toolchains belong to independently installed Local provider apps.
USER node
EXPOSE 3400
CMD ["node", "api.mjs"]
