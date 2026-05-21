/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: process.env.NEXT_DIST_DIR || ".next",
  output: "standalone",
  serverExternalPackages: [
    "better-sqlite3", 
    "sql.js", 
    "node:sqlite", 
    "bun:sqlite",
    // --- ADD YOUR TUNNEL/SSH PACKAGES HERE ---
    "ssh2",          // Most likely culprit for tunnel routes
    "node-ssh",      // Alternative SSH library
    "jsonwebtoken",  // If used for tunnel auth
    "jose",          // Often used alongside crypto
  ],

  outputFileTracingExcludes: {
    "*": ["./gitbook/**/*"]
  },
  images: {
    unoptimized: true
  },
  env: {},
  webpack: (config, { isServer }) => {
    // Ignore fs/path/crypto modules in browser bundle
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        crypto: false, // Prevent browser crypto polyfill from leaking to server
      };
    } else {
      // Force server-side to use native Node.js crypto instead of polyfills
      // This resolves the "crypto.randomBytes is not a function" error
      config.resolve.alias = {
        ...config.resolve.alias,
        crypto: false, 
      };
    }
    
    // Exclude logs, .next, gitbook subapp from watcher
    config.watchOptions = { ...config.watchOptions, ignored: /[\\/](logs|\.next|gitbook|cli)[\\/]/ };
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