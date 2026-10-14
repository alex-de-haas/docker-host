FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
WORKDIR /opt/hosty
COPY --chmod=444 relay.mjs ./relay.mjs
USER 1000:1000
ENTRYPOINT ["node", "/opt/hosty/relay.mjs"]
