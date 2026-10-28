# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:22.23.4-alpine
# CN mirror by default (fork build host); override with --build-arg ALPINE_MIRROR=...
ARG ALPINE_MIRROR=mirrors.aliyun.com
ARG NPM_REGISTRY=https://registry.npmjs.org/
ARG APP_VERSION=unknown

# ==========================================
# STAGE 1: BUILD
# ==========================================
FROM ${NODE_IMAGE} AS base
ARG ALPINE_MIRROR
WORKDIR /app

RUN if [ "$ALPINE_MIRROR" != "dl-cdn.alpinelinux.org" ]; then \
      sed -i "s|dl-cdn.alpinelinux.org|${ALPINE_MIRROR}|g" /etc/apk/repositories; \
    fi

FROM base AS builder
ARG NPM_REGISTRY

# Mark this as a Docker image — required for Next.js build-time detection of public env var
ENV NEXT_PUBLIC_APP_IMAGE_SHA=docker
ENV NEXT_TELEMETRY_DISABLED=1
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

# Gabung jadi satu RUN, kurangi layer & secret mounts
RUN apk add --no-cache python3 make g++ linux-headers curl wget git

COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund --registry="${NPM_REGISTRY}"

COPY . ./
RUN npm run build

# https://github.com/decolua/9router/issues/5245
# wreq-js and playwright-core are lazy runtime dependencies (loaded by
# lazyRuntime.js via createRequire). Next standalone tracing does not include
# them, so OpenCode Free fails with HTTP 502 ("resolve is undefined").
# Install them (with their native bindings/transitive deps) in an isolated dir
# so the runner stage can copy them into /app/node_modules.
RUN --mount=type=cache,target=/root/.npm \
    mkdir -p /opt/lazy-runtime && cd /opt/lazy-runtime && \
    npm init -y >/dev/null && \
    npm install --no-save \
      --registry="${NPM_REGISTRY}" \
      --fetch-retries=5 \
      --fetch-retry-factor=2 \
      --fetch-retry-mintimeout=10000 \
      --fetch-retry-maxtimeout=120000 \
      --fetch-timeout=300000 \
      wreq-js playwright-core

# ==========================================
# STAGE 2: RUNNER
# ==========================================
FROM ${NODE_IMAGE} AS runner
ARG ALPINE_MIRROR
ARG APP_VERSION
WORKDIR /app

RUN if [ "$ALPINE_MIRROR" != "dl-cdn.alpinelinux.org" ]; then \
      sed -i "s|dl-cdn.alpinelinux.org|${ALPINE_MIRROR}|g" /etc/apk/repositories; \
    fi

LABEL org.opencontainers.image.title="9router" \
      org.opencontainers.image.version="${APP_VERSION}"

ENV NODE_ENV=production
ENV PORT=20128
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_PUBLIC_APP_IMAGE_SHA=docker
ENV DATA_DIR=/app/data

COPY --chown=node:node --from=builder /app/public ./public
COPY --chown=node:node --from=builder /app/.next/static ./.next/static
COPY --chown=node:node --from=builder /app/.next/standalone ./
COPY --chown=node:node --from=builder /app/custom-server.js ./custom-server.js
COPY --chown=node:node --from=builder /app/open-sse ./open-sse
# Next file tracing can omit sibling files; MITM runs server.js as a separate process.
COPY --chown=node:node --from=builder /app/src/mitm ./src/mitm
# Runtime `@/*` imports outside .next/standalone (DB, shared services).
COPY --chown=node:node --from=builder /app/src/shared ./src/shared
COPY --chown=node:node --from=builder /app/src/lib ./src/lib

COPY --chown=node:node --from=builder /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
COPY --chown=node:node --from=builder /app/node_modules/node-forge ./node_modules/node-forge
# Ensure `next` is available at runtime in case tracing did not include it.
COPY --chown=node:node --from=builder /app/node_modules/next ./node_modules/next
# sql.js loads dist/sql-wasm.wasm by path at runtime; tracing only follows JS imports,
# so the last-resort DB driver would abort with ENOENT on the missing binary.
COPY --chown=node:node --from=builder /app/node_modules/sql.js ./node_modules/sql.js
# node-machine-id is createRequire-loaded at runtime; tracing omits it.
COPY --chown=node:node --from=builder /app/node_modules/node-machine-id ./node_modules/node-machine-id
# wreq-js + playwright-core (and deps) are lazy-loaded at runtime and omitted by
# tracing. See https://github.com/decolua/9router/issues/5245
COPY --chown=node:node --from=builder /opt/lazy-runtime/node_modules/. ./node_modules/

RUN mkdir -p /app/data /app/data-home && \
  chown -R node:node /app/data /app/data-home && \
  ln -sf /app/data-home /root/.9router 2>/dev/null || true

# curl doubles as the HEALTHCHECK probe; su-exec drops to node at runtime; ffmpeg
# converts audio for the Codex OAuth STT provider.
RUN apk add --no-cache curl su-exec ffmpeg && \
  printf '#!/bin/sh\nchown -R node:node /app/data /app/data-home 2>/dev/null\nexec su-exec node "$@"\n' > /entrypoint.sh && \
  chmod +x /entrypoint.sh

EXPOSE 20128

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:20128/api/version || exit 1

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "custom-server.js"]
