# ==========================================
# STAGE 1: BUILD (Tetap Sama)
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
# STAGE 2: RUNNER (Fix Permission untuk Volume)
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

# Fix Database
COPY --from=builder /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
COPY --from=builder /app/node_modules/sql.js/dist/sql-wasm.wasm ./node_modules/sql.js/dist/sql-wasm.wasm
COPY --from=builder /app/node_modules/node-forge ./node_modules/node-forge

# Setup user non-root
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nextjs -u 1001

# Buat folder awal (sebagai fallback jika volume belum di-mount)
RUN mkdir -p /app/data /app/data-home

# --- MAGIC FIX PERMISSION COOLIFY ---
# 1. Install su-exec (untuk ganti user saat runtime)
# 2. Buat script entrypoint yang dijalankan sebagai ROOT
# Script ini akan mengubah kepemilikan folder volume ke user nextjs, 
# lalu menyerahkan kendali ke user nextjs untuk menjalankan "node server.js"
RUN apk --no-cache add su-exec && \
    printf '#!/bin/sh\nchown -R nextjs:nodejs /app/data /app/data-home 2>/dev/null\nexec su-exec nextjs "$@"\n' > /entrypoint.sh && \
    chmod +x /entrypoint.sh

# Setup symlink config user
RUN ln -sf /app/data-home /home/nextjs/.9router 2>/dev/null || true

EXPOSE 20128

# JANGAN pakai USER nextjs di sini!
# Container akan start sebagai ROOT, jalankan /entrypoint.sh, 
# lalu entrypoint.sh akan menurunkan hak akses ke nextjs.
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "server.js"]