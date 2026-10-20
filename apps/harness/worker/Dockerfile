FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS dependencies
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/harness/package.json apps/harness/package.json
COPY apps/harness/web/package.json apps/harness/web/package.json
COPY packages/app-sdk/package.json packages/app-sdk/package.json
RUN npm ci --omit=dev --no-audit --no-fund --workspace @haas/hosty-harness --workspace @hosty-sdk/app

FROM mcr.microsoft.com/dotnet/sdk:10.0@sha256:2fa828c68761b1b8c23d7662dc134421b9d3b59fe1425fdbc80804e390cdb24d AS git-build
# Relative worktree metadata needs Git >= 2.48 on both Core and Worker.
ARG GIT_VERSION=2.56.0
ARG GIT_SHA256=26c56c296b38c0695b26fa95f475f1d01704d2d38e73465ca30b0b2f5dc789d3
RUN apt-get update && apt-get install -y --no-install-recommends build-essential libcurl4-openssl-dev libssl-dev libexpat1-dev zlib1g-dev gettext curl xz-utils \
    && curl -fsSL "https://www.kernel.org/pub/software/scm/git/git-${GIT_VERSION}.tar.xz" -o /tmp/git.tar.xz \
    && echo "${GIT_SHA256}  /tmp/git.tar.xz" | sha256sum -c - \
    && mkdir /tmp/git && tar -xJf /tmp/git.tar.xz -C /tmp/git --strip-components=1 \
    && make -C /tmp/git -j4 prefix=/opt/git NO_TCLTK=YesPlease NO_RUST=YesPlease install

FROM mcr.microsoft.com/dotnet/sdk:10.0@sha256:2fa828c68761b1b8c23d7662dc134421b9d3b59fe1425fdbc80804e390cdb24d
COPY --from=git-build /opt/git /opt/git
COPY --from=dependencies /usr/local/bin/node /usr/local/bin/node
COPY --from=dependencies /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && apt-get update && apt-get install -y --no-install-recommends git python3 ripgrep ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY --from=dependencies /repo/node_modules ./node_modules
COPY apps/harness ./apps/harness
COPY packages/app-sdk ./packages/app-sdk
COPY shared ./shared
RUN mkdir -p /opt/hosty-worker /control /work /run/hosty-execution \
    && chmod 700 /control && chmod 711 /run/hosty-execution \
    && ln -s /repo/node_modules/.bin/codex /opt/hosty-worker/codex \
    && node -e 'const fs=require("fs");fs.symlinkSync(require.resolve("@anthropic-ai/claude-agent-sdk-linux-"+process.arch+"/claude"),"/opt/hosty-worker/claude")'
ENV PATH="/opt/git/bin:/opt/hosty-worker:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1
# The backend owns protected control mounts and launches agent CLIs with an unprivileged UID.
WORKDIR /repo/apps/harness
EXPOSE 3401
ENTRYPOINT ["tini", "--"]
CMD ["node", "--import", "tsx", "src/worker/main.ts"]
