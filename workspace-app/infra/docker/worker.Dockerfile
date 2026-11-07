# syntax=docker/dockerfile:1.7
# Worker (pg-boss) van de HomeZero Workspace (HZW-004). Context: workspace-app/.
#   docker build -f infra/docker/worker.Dockerfile -t ghcr.io/<org>/hz-worker:<tag> .
ARG NODE_IMAGE=node:22.20.0-alpine3.22

FROM ${NODE_IMAGE} AS build
WORKDIR /src
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm fetch
COPY . .
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --offline --frozen-lockfile
RUN infra/docker/build-app.sh worker /out

FROM ${NODE_IMAGE}
ARG HZ_RELEASE=dev
ENV NODE_ENV=production \
    HZ_LOG_FORMAT=json \
    HZ_WORKER_HEARTBEAT=/tmp/hz-worker-alive \
    HZ_RELEASE=${HZ_RELEASE}
WORKDIR /app
COPY --from=build /out /app
USER node
# Hartslag (packages/ops): het bestand moet jonger zijn dan 90 seconden, anders is de worker 'unhealthy'.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "dist/ops-cli.js", "heartbeat-ok"]
CMD ["node", "--enable-source-maps", "dist/index.js"]
