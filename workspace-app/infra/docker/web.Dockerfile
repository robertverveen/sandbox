# syntax=docker/dockerfile:1.7
# Web-app (React + Vite) van de HomeZero Workspace (HZW-004), geserveerd door Caddy. Context: workspace-app/.
#   docker build -f infra/docker/web.Dockerfile -t ghcr.io/<org>/hz-web:<tag> .
ARG NODE_IMAGE=node:22.20.0-alpine3.22
ARG CADDY_IMAGE=caddy:2.10.2-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /src
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm fetch
COPY . .
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --offline --frozen-lockfile
RUN pnpm --filter @hz/web build \
 && mkdir -p /out \
 && node infra/docker/web-csp.mjs apps/web/dist/index.html /out/csp.caddy

FROM ${CADDY_IMAGE}
# Geen root nodig: poort 8080, geen eigen certificaten (TLS doet de bestaande proxy), config niet bewaren.
ENV XDG_CONFIG_HOME=/tmp/caddy-config XDG_DATA_HOME=/tmp/caddy-data HZ_API_UPSTREAM=api:8700
COPY --from=build /src/apps/web/dist /srv/web
COPY --from=build /out/csp.caddy /etc/caddy/csp.caddy
COPY infra/docker/web.Caddyfile /etc/caddy/Caddyfile
USER 65534:65534
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
