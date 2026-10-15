FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS node
FROM mcr.microsoft.com/dotnet/sdk:10.0@sha256:2fa828c68761b1b8c23d7662dc134421b9d3b59fe1425fdbc80804e390cdb24d
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && apt-get update && apt-get install -y --no-install-recommends git python3 ripgrep ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/hosty-worker
# These versions must match Harness; check-versions validates the worker metadata.
COPY apps/harness/worker/package.json apps/harness/worker/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && ln -s node_modules/.bin/codex /opt/hosty-worker/codex \
    && node -e 'const fs=require("fs");fs.symlinkSync(require.resolve("@anthropic-ai/claude-agent-sdk-linux-"+process.arch+"/claude"),"/opt/hosty-worker/claude")' \
    && npm cache clean --force
ENV PATH="/opt/hosty-worker:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1
USER 1000:1000
WORKDIR /tmp
CMD ["sleep", "infinity"]
