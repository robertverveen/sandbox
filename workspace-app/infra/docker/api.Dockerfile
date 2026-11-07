# syntax=docker/dockerfile:1.7
# API (Hono) van de HomeZero Workspace (HZW-004). Context: workspace-app/.
#   docker build -f infra/docker/api.Dockerfile -t ghcr.io/<org>/hz-api:<tag> .
ARG NODE_IMAGE=node:22.20.0-alpine3.22

FROM ${NODE_IMAGE} AS build
WORKDIR /src
RUN corepack enable
# Eerst alleen de lockfile: pnpm fetch vult de store, zodat deze laag gecachet blijft zolang de lockfile gelijk is.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm fetch
COPY . .
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --offline --frozen-lockfile
RUN infra/docker/build-app.sh api /out

FROM ${NODE_IMAGE}
ARG HZ_RELEASE=dev
ENV NODE_ENV=production \
    HZ_API_HOST=0.0.0.0 \
    HZ_API_PORT=8700 \
    HZ_LOG_FORMAT=json \
    HZ_RELEASE=${HZ_RELEASE}
WORKDIR /app
# Code is van root en alleen leesbaar voor de app-gebruiker; het proces draait als 'node' (geen root).
COPY --from=build /out /app
USER node
EXPOSE 8700
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8700/api/health').then(r=>r.json()).then(j=>process.exit(j.ok&&j.db!=='error'?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/index.js"]
