# ==========================================
# STAGE 1: BUILD
# ==========================================
FROM node:22-alpine AS builder

ENV NPM_CONFIG_UPDATE_NOTIFIER=false
ENV NEXT_TELEMETRY_DISABLED=1

# Mark this as a Docker image — required for Next.js build-time detection of public env var
ENV NEXT_PUBLIC_APP_IMAGE_SHA=docker

WORKDIR /app

# Gabung jadi satu RUN, kurangi layer & secret mounts
RUN apk add --no-cache python3 make g++ curl wget git

COPY package.json package-lock.json* ./
RUN npm install --silent

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

# Health check cuma butuh curl, bukan git/wget
RUN apk add --no-cache curl && mkdir -p /app/data /app/data-home

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/custom-server.js ./custom-server.js
COPY --from=builder /app/open-sse ./open-sse
COPY --from=builder /app/src/mitm ./src/mitm
COPY --from=builder /app/src/shared ./src/shared
COPY --from=builder /app/src/lib ./src/lib

COPY --from=builder /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
COPY --from=builder /app/node_modules/node-forge ./node_modules/node-forge
# Ensure `next` is available at runtime in case tracing did not include it.
COPY --from=builder /app/node_modules/next ./node_modules/next
# sql.js loads dist/sql-wasm.wasm by path at runtime; tracing only follows JS imports,
# so the last-resort DB driver would abort with ENOENT on the missing binary.
COPY --from=builder /app/node_modules/sql.js ./node_modules/sql.js

RUN mkdir -p /app/data && chown -R node:node /app && \
  mkdir -p /app/data-home && chown node:node /app/data-home && \
  ln -sf /app/data-home /root/.9router 2>/dev/null || true

# Fix permissions at runtime (handles mounted volumes)
RUN apk --no-cache upgrade && apk --no-cache add su-exec && \
  printf '#!/bin/sh\nchown -R node:node /app/data /app/data-home 2>/dev/null\nexec su-exec node "$@"\n' > /entrypoint.sh && \
  chmod +x /entrypoint.sh

EXPOSE 20128

CMD ["node", "server.js"]