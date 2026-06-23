const proxyClientMaxBodySize = process.env.NINEROUTER_PROXY_CLIENT_MAX_BODY_SIZE || "128mb";

/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: process.env.NEXT_DIST_DIR || ".next",
  output: "standalone",
  serverExternalPackages: [
    "better-sqlite3", 
    "sql.js", 
    "node:sqlite", 
    "bun:sqlite",
    "node-forge",   // <-- WAJIB DITAMBAHKAN (Ini penyebab utama di chunk 2971)
    "ssh2",         // <-- Tambahkan jika kamu pakai library SSH
    "node-ssh",     // <-- Tambahkan jika kamu pakai ini
  ],

  outputFileTracingExcludes: {
    "*": ["./gitbook/**/*"]
  },
  images: {
    unoptimized: true
  },
  env: {},
  experimental: {
    proxyClientMaxBodySize,
    serverComponentsHmrCache: true,
  },
  webpack: (config, { isServer }) => {
    if (isServer) {
      // FIX UTAMA: Hapus alias crypto bawaan Next.js agar Node.js native crypto digunakan
      if (config.resolve.alias && config.resolve.alias.crypto) {
        delete config.resolve.alias.crypto;
      }
    } else {
      // Ignore fs/path/crypto modules in browser bundle
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        crypto: false, // Browser tidak butuh crypto Node.js
      };
    }
    // Exclude non-source dirs from watcher to reduce inotify load
    config.watchOptions = {
      ...config.watchOptions,
      aggregateTimeout: 300,
      ignored: /[\\/](node_modules|\.git|logs|\.next|\.next-cli-build|gitbook|cli|open-sse\.old|tests|docs)[\\/]/,
    };
    return config;
  },
  async rewrites() {
    return [
      {
        source: "/v1/v1/:path*",
        destination: "/api/v1/:path*"
      },
      {
        source: "/v1/v1",
        destination: "/api/v1"
      },
      {
        source: "/codex/:path*",
        destination: "/api/v1/responses"
      },
      {
        source: "/responses",
        destination: "/api/v1/responses"
      },
      {
        source: "/v1/:path*",
        destination: "/api/v1/:path*"
      },
      {
        source: "/v1",
        destination: "/api/v1"
      }
    ];
  }
};

export default nextConfig;