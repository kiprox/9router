# ==========================================
# STAGE 1: BUILD (Menggunakan Node.js)
# ==========================================
FROM node:22-alpine AS builder

WORKDIR /app

# Install tools untuk compile better-sqlite3 (C++ native module)
RUN apk add --no-cache python3 make g++

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies (npm install aman jika tidak ada lock file)
RUN npm install

# Copy SELURUH source code
COPY . ./

ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ==========================================
# STAGE 2: RUNNER (Menggunakan Node.js)
# ==========================================
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=20128
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATA_DIR=/app/data

# Copy hasil build Next.js standalone
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/.next/standalone ./

# Copy file spesifik yang tidak ikut ter-bundle otomatis oleh Next.js
COPY --from=builder /app/open-sse ./open-sse
COPY --from=builder /app/src/mitm ./src/mitm

# FIX DATABASE 1: Pastikan binary better-sqlite3 yang sudah di-compile ikut ke runner
COPY --from=builder /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3

# FIX DATABASE 2: Bawa file WASM sql.js sebagai fallback (jika better-sqlite3 tiba-tiba error)
COPY --from=builder /app/node_modules/sql.js/dist/sql-wasm.wasm ./node_modules/sql.js/dist/sql-wasm.wasm

# Copy module lain yang dibutuhkan proses tersier (MITM)
COPY --from=builder /app/node_modules/node-forge ./node_modules/node-forge

# Setup user non-root dan folder data (sesuai aslinya)
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nextjs -u 1001 && \
    mkdir -p /app/data && chown -R nextjs:nodejs /app && \
    mkdir -p /app/data-home && chown nextjs:nodejs /app/data-home && \
    ln -sf /app/data-home /home/nextjs/.9router 2>/dev/null || true

EXPOSE 20128

USER nextjs

# Gunakan Node.js untuk menjalankan server, BUKAN Bun
CMD ["node", "server.js"]