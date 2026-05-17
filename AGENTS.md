# AGENTS.md

## Repo shape
- Root (`sirouter`): private Next.js 16 app (React 19) — API gateway + dashboard. Entry: `src/server-init.js` → `src/shared/services/initializeApp.js`.
- `open-sse/`: provider/translator lib, imported via alias `open-sse/*` (see `jsconfig.json`).
- `cli/`: published npm package (`9router`), own `package.json`. Bundled via esbuild; postinstall hook installs runtime deps into `~/.9router/runtime/node_modules` to avoid EBUSY on global updates.
- `gitbook/`: independent Next.js docs site, own `package.json`; static export deployed to GitHub Pages.

## Commands
```bash
# Root (Next.js app)
npm run dev        # next dev --webpack --port 20128
npm run build      # next build --webpack
npm start          # next start (NODE_ENV=production via Dockerfile)
npm run dev:bun    # bun --bun next dev --webpack --port 20128
npm run build:bun  # bun --bun next build --webpack
npm run start:bun  # bun ./.next/standalone/server.js
npx eslint .       # flat config: eslint.config.mjs

# gitbook/ (run inside that dir)
npm run dev        # port 3001
npm run build      # static export → out/

# cli/ (run inside that dir)
npm run build      # esbuild bundle
npm run pack:cli   # build + npm pack
npm run publish:cli # build + npm publish
```
- No root `npm test`; CI still runs `npm test` (fails). Add test script if needed.
- `npm run build` reads `.env.build` for build-time env vars.

## Architecture & runtime gotchas
- Port `20128` hard-coded in scripts and Dockerfile `PORT` env; change both if updating.
- `next.config.mjs` has `DO NOT CHANGE - dont stage this` comment — do not commit changes to it.
- `output: "standalone"` — Dockerfile copies `.next/standalone` plus `open-sse/`, `src/mitm/`, `src/shared/`, `src/lib/`, and native/wasm deps.
- Rewrites: `/v1/*` & `/codex/*` → `/api/v1/*`; `/v1/v1/*` intentional duplicate.
- `initializeApp` uses `global.__appSingleton` to survive Next.js hot reload; registers SIGINT/SIGTERM cleanup for DNS & cloudflared.
- MITM server binds port 443 (port 8443 on Windows); requires sudo/admin for DNS hosts-file edits.
- MITM manager is CJS (`src/mitm/manager.js`); ESM bootstrap injects `process.env.MITM_SERVER_PATH`.
- MITM server.js is copied from `node_modules` to `DATA_DIR/runtime/mitm/` at startup to avoid locking the install dir.

## DB & data dir
- SQLite driver order (`src/lib/db/driver.js`): Bun `bun:sqlite` → `sql.js`; optional `better-sqlite3`; Node built-in `node:sqlite` (≥22.5) → fallback `sql.js`.
- Data directory: `DATA_DIR` env or `~/.9router` (Windows `%APPDATA%\9router`). Unwritable `DATA_DIR` falls back to default (`src/lib/dataDir.js`).
- Docker sets `DATA_DIR=/app/data`.

## Tunnel & env
- Tunnel manager: `src/lib/tunnel/tunnelManager.js` + `src/lib/tunnel/cloudflared.js`; Tailscale auto-resumes from settings.
- Public domain: `PUBLIC_DOMAIN` or `TUNNEL_PUBLIC_DOMAIN` (default `9router.com`).
- Worker URL: `TUNNEL_WORKER_URL` (default `https://9router.com`).
- Full env var list: `.env.build`.

## CI / release
- Docker: push to GHCR + Docker Hub on `v*` tag or manual dispatch (`.github/workflows/docker-publish.yml`); Node 22-alpine, multi-platform (amd64/arm64).
- GitBook: deploy on changes under `gitbook/` (`.github/workflows/gitbook-pages.yml`); Node 24.
- NPM publish: triggered by GitHub Release (`.github/workflows/npm-publish.yml`); Node 20; publishes root app (private — likely misconfigured), not `cli/`. The CLI is published manually via `cli/npm run publish:cli`.
- Docker `output: "standalone"` bundles `.next/standalone`, `open-sse/`, `src/mitm/`, `src/shared/`, `src/lib/`, and native/wasm deps (`better-sqlite3`, `sql.js`, `node-forge`).
