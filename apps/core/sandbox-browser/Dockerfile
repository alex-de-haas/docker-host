FROM mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f
WORKDIR /opt/hosty
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY worker.mjs policy.mjs ./
USER pwuser
ENV HOME=/tmp
ENTRYPOINT ["node", "/opt/hosty/worker.mjs"]
