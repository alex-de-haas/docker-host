# Trusted dependency preparation is explicit and separate from offline sandbox execution.
FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS dependencies
WORKDIR /opt/hosty/prepared
COPY package.json package-lock.json ./
COPY apps/demo-app/package.json apps/demo-app/package.json
COPY packages/app-sdk/package.json packages/app-sdk/package.json
RUN npm ci --workspace @haas/hosty-demo-app --ignore-scripts --no-audit --no-fund
COPY apps/demo-app/sandbox/prepare.mjs /opt/hosty/prepare.mjs
RUN node /opt/hosty/prepare.mjs --record /opt/hosty/prepared

FROM dependencies AS development
ENV NEXT_TELEMETRY_DISABLED=1
COPY apps/demo-app/sandbox/dev-entrypoint.sh /opt/hosty/dev-entrypoint.sh
ENTRYPOINT ["/bin/sh", "/opt/hosty/dev-entrypoint.sh"]
WORKDIR /workspace/apps/demo-app
CMD ["node", "--version"]

FROM dependencies AS artifact-build
WORKDIR /opt/hosty/prepared
COPY packages/app-sdk packages/app-sdk
COPY apps/demo-app apps/demo-app
ENV NEXT_TELEMETRY_DISABLED=1
RUN --network=none npm run build --workspace @haas/hosty-demo-app

FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS artifact
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
COPY --from=artifact-build /opt/hosty/prepared/apps/demo-app/.next/standalone ./
COPY --from=artifact-build /opt/hosty/prepared/apps/demo-app/.next/static ./apps/demo-app/.next/static
COPY --from=artifact-build /opt/hosty/prepared/apps/demo-app/public ./apps/demo-app/public
USER 1000:1000
CMD ["node", "apps/demo-app/server.js"]
