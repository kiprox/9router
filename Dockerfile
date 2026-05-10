# ==========================================
# STAGE 1: BUILD
# ==========================================
FROM node:22-alpine AS builder

WORKDIR /app
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json* ./
RUN npm install

COPY . ./
ENV NEXT_TELEMETRY_DISABLED=1
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
ENV DATA_DIR=/app/data

# Copy hasil build
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/open-sse ./open-sse
COPY --from=builder /app/src/mitm ./src/mitm

# ---> Sibling Folder <---
COPY --from=builder /app/src/shared ./src/shared
COPY --from=builder /app/src/lib ./src/lib
# --------------------------------

# Fix Database
COPY --from=builder /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
COPY --from=builder /app/node_modules/sql.js/dist/sql-wasm.wasm ./node_modules/sql.js/dist/sql-wasm.wasm
COPY --from=builder /app/node_modules/node-forge ./node_modules/node-forge

# Test install cUrl
RUN apk add --no-cache curl

# Setup user non-root
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nextjs -u 1001

# Buat folder awal
RUN mkdir -p /app/data /app/data-home

# Install su-exec untuk ganti user di runtime
RUN apk --no-cache add su-exec

# COPY file entrypoint.sh yang sudah kita buat di luar
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Setup symlink config user
RUN ln -sf /app/data-home /home/nextjs/.9router 2>/dev/null || true

EXPOSE 20128

# Container start sebagai root, lalu entrypoint.sh menurunkannya ke nextjs
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "server.js"]