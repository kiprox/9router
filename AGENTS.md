# AGENTS.md

## Repo shape

- Root (`sirouter`): private Next.js 16 app (React 19) — AI routing gateway + dashboard. Plain JS (no TypeScript).
- `open-sse/`: provider/translator lib, bundled with root app via alias `open-sse/*` (see `jsconfig.json`). No own `package.json`.
- `cli/`: published npm package `9router`, own `package.json`. Bundled via esbuild (`node scripts/build-cli.js`). Not in root workspace.
- `gitbook/`: independent Next.js docs site, own `package.json`; static export (`output: "export"`), deployed to `9router.github.io` via GH Pages.
- `cloudflare/worker/`: Cloudflare Worker (KV-backed), deployed separately via Wrangler.
- `tests/unit/`: vitest files — **vitest is not in root `package.json`**; `npm test` will fail.

## Commands

```bash
# Root (Next.js app)
npm run dev        # next dev --webpack --port 20128
npm run build      # next build --webpack
npm run dev:bun    # bun --bun next dev --webpack --port 20128
npm run build:bun  # bun --bun next build --webpack
npm run start:bun  # bun ./.next/standalone/server.js
npx eslint .       # flat config: eslint.config.mjs (core-web-vitals preset)

# gitbook/ (run from gitbook/ dir)
npm run dev        # next dev -p 3001
npm run build      # next build (static export → out/)

# cli/ (run from cli/ dir)
npm run build      # node scripts/build-cli.js (esbuild bundle)
npm run pack:cli   # build + npm pack --pack-destination ../..
npm run publish:cli # build + npm publish
```

- `.env.build` is a **reference** listing all env vars the app reads at runtime (not auto-loaded). Coolify loads it in deployment; for local dev, set vars manually or use `.env.local`.
- No root `npm test` — CI npm-publish workflow runs `npm test` and will fail.

## App initialization chain

```
src/app/layout.js  (side-effect import)
  → src/shared/services/bootstrap.js
    → src/shared/services/initializeApp.js
      (watchdog, tunnel/Tailscale auto-resume, MITM auto-start, network monitor)
```

No `server-init.js` exists. The entrypoint is the Next.js router itself. `initializeApp` survives hot reload via `global.__appSingleton`.

## Architecture & runtime gotchas

- Port `20128` hard-coded in npm scripts and Dockerfile `PORT` env.
- Rewrites (`next.config.mjs`): `/v1/*` & `/codex/*` → `/api/v1/*`; `/v1/v1/*` intentional duplicate for Codex CLI compat.
- Auth middleware at `src/proxy.js` + `src/dashboardGuard.js` — file is NOT named `middleware.js` (unconventional, middleware won't run unless renamed). Implements API key, JWT, CLI token, local-only path checks.
- MITM server (`src/mitm/server.js`) binds port 443; requires sudo/admin for DNS hosts-file edits. Copied from `node_modules` to `DATA_DIR/runtime/mitm/` at startup to avoid locking install dir.
- `src/store/`: zustand stores (provider, settings, theme, user, notification, headerSearch).
- `src/i18n/`: runtime i18n config + React provider.

## DB & data dir

- SQLite driver order (`src/lib/db/driver.js`): Bun `bun:sqlite` → `better-sqlite3` → Node `node:sqlite` (≥22.5) → `sql.js` (fallback).
- `better-sqlite3` is **optionalDependency** — if native build fails, sql.js fallback at runtime.
- Data directory: `DATA_DIR` env or `~/.9router` (Windows `%APPDATA%\9router`). Docker sets `DATA_DIR=/app/data`.

## Webpack config quirks (`next.config.mjs`)

- `serverExternalPackages`: `better-sqlite3`, `sql.js`, `node:sqlite`, `bun:sqlite`, `node-forge`, `ssh2`, `node-ssh`.
- Server-side: deletes `crypto` alias from resolve to force native Node.js crypto.
- Client-side fallbacks: `fs: false`, `path: false`, `crypto: false`.
- `output: "standalone"` for Docker builds.

## Key source layout

| Area | Location |
|------|----------|
| API routes (LLM compat) | `src/app/api/v1/*` |
| API routes (management) | `src/app/api/*` |
| API routes (auth) | `src/app/api/oauth/*` |
| SSE chat core | `src/sse/handlers/chat.js` → `open-sse/handlers/chatCore.js` → `open-sse/executors/*` |
| Translator | `open-sse/translator/` |
| Persistence | `src/lib/db/` (SQLite repos); `src/lib/localDb.js` / `src/lib/usageDb.js` are thin shims |
| Auth | `src/lib/auth/dashboardSession.js` (JWT), `src/lib/oauth/` (OAuth flows) |
| Dashboard pages | `src/app/dashboard/`, `src/app/login/`, `src/app/landing/` |

## CLI package (`cli/`)

- `postinstall` hook installs runtime deps (sql.js, better-sqlite3, systray2) into `~/.9router/runtime/node_modules` — avoids EBUSY on global updates.
- Tray: uses `systray2` fork on macOS/Linux; Windows uses PowerShell `NotifyIcon`.
- Commands must be run from `cli/` directory.
- `engines.node >= 18`.

## Docker build

- Builder stage installs `python3 make g++ curl wget git` for native modules.
- Runner stage copies only needed dirs: `open-sse/`, `src/mitm/`, `src/shared/`, `src/lib/`, plus native deps (`better-sqlite3`, `sql.js` wasm, `node-forge`).
- Multi-platform (amd64/arm64). Pushed to GHCR + Docker Hub on `v*` tag.

## CI

- **docker-publish.yml**: on `v*` tag or manual dispatch. Buildx, cache from registry.
- **gitbook-pages.yml**: on push to `main` changing `gitbook/**`. Node 24. Deploys static export to external `9router/9router.github.io` repo via deploy key.
- **npm-publish.yml**: on release. Runs `npm test` (will fail — no test framework installed). CLI is published manually via `cli/` `npm run publish:cli`.
