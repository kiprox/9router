# ==========================================
# STAGE 1: BUILD
# ==========================================
FROM node:22-alpine AS builder

ENV NPM_CONFIG_UPDATE_NOTIFIER=false
ENV NEXT_TELEMETRY_DISABLED=1

# Mark this as a Docker image — required for Next.js build-time detection of public env var
ENV NEXT_PUBLIC_APP_IMAGE_SHA=docker

WORKDIR /app
# CN mirror for apk (used by builder and runner stages)
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.aliyun.com|g' /etc/apk/repositories

# Gabung jadi satu RUN, kurangi layer & secret mounts
RUN apk add --no-cache python3 make g++ curl wget git

COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

COPY . ./
RUN npm run build


# ==========================================
# STAGE 2: RUNNER
# ==========================================
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=20128
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_PUBLIC_APP_IMAGE_SHA=docker
ENV DATA_DIR=/app/data

# curl doubles as the HEALTHCHECK probe; su-exec drops to node at runtime.
RUN apk add --no-cache curl su-exec && mkdir -p /app/data /app/data-home && \
  chown -R node:node /app/data /app/data-home && \
  ln -sf /app/data-home /root/.9router 2>/dev/null || true && \
  printf '#!/bin/sh\nchown -R node:node /app/data /app/data-home 2>/dev/null\nexec su-exec node "$@"\n' > /entrypoint.sh && \
  chmod +x /entrypoint.sh

# Official OpenCode CLI (standalone musl build) — the only client the free-tier
# gate accepts (TLS/h2-stack fingerprint). `opencode serve` (v2 API) is spawned
# on demand by open-sse/services/opencodeLocal.js for free-model delegation.
# TARGETARCH is a BuildKit auto-platform arg — declare it or it stays empty.
ARG TARGETARCH
ARG OPENCODE_VERSION=2.0.29
RUN set -eux; \
  case "${TARGETARCH:-amd64}" in \
    amd64) oc_arch="x64" ;; \
    arm64) oc_arch="arm64" ;; \
    *) echo "unsupported TARGETARCH: ${TARGETARCH:-amd64}" >&2; exit 1 ;; \
  esac; \
  curl -fsSL "https://opencode.ai/files/bin/${OPENCODE_VERSION}/opencode-linux-${oc_arch}-musl.tar.gz" \
    | tar -xz -C /usr/local/bin opencode; \
  chmod 0755 /usr/local/bin/opencode; \
  opencode --version

# Route free-model requests through the bundled local `opencode serve`.
ENV OPENCODE_DELEGATE=on

COPY --chown=node:node --from=builder /app/public ./public
COPY --chown=node:node --from=builder /app/.next/static ./.next/static
COPY --chown=node:node --from=builder /app/.next/standalone ./
COPY --chown=node:node --from=builder /app/custom-server.js ./custom-server.js
COPY --chown=node:node --from=builder /app/open-sse ./open-sse
COPY --chown=node:node --from=builder /app/src/mitm ./src/mitm
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

EXPOSE 20128

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:20128/api/version || exit 1

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "custom-server.js"]
