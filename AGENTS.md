# AGENTS.md

## Repo shape
- Root (`sirouter`): private Next.js 16 app (React 19) — AI routing gateway + dashboard. Entry: `src/server-init.js` → `src/shared/services/initializeApp.js`.
- `open-sse/`: provider/translator lib, imported via alias `open-sse/*` (see `jsconfig.json`). No own `package.json`; bundled with root app.
- `cli/`: published npm package (`9router`), own `package.json`. Bundled via esbuild; postinstall hook installs runtime deps (sql.js, better-sqlite3, systray2) into `~/.9router/runtime/node_modules` to avoid EBUSY on global updates.
- `gitbook/`: independent Next.js docs site, own `package.json`; static export (`output: "export"`) deployed to external repo `9router/9router.github.io` via GH Pages.
- `cloudflare/worker/`: Cloudflare Worker for tunnel registration (KV-backed). Deployed separately via Wrangler.
- `tests/unit/`: vitest test files — **vitest is not in root package.json**, tests are non-functional as-is.

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

# There is no root npm test; CI npm-publish.yml runs `npm test` (will fail).

# gitbook/ (run inside that dir)
npm run dev        # next dev -p 3001
npm run build      # next build (static export → out/)

# cli/ (run inside that dir)
npm run build      # node scripts/build-cli.js (esbuild bundle)
npm run pack:cli   # build + npm pack --pack-destination ../..
npm run publish:cli # build + npm publish
```
- `npm run build` loads `.env.build` for build-time env vars.
- Docker build: `output: "standalone"`, multi-platform (amd64/arm64), pushes to GHCR + Docker Hub on `v*` tag.

## Architecture & runtime gotchas
- Port `20128` hard-coded in scripts and Dockerfile `PORT` env; change both if updating.
- `next.config.mjs` has `DO NOT CHANGE - dont stage this` comment — do not commit changes to it.
- Rewrites: `/v1/*` & `/codex/*` → `/api/v1/*`; `/v1/v1/*` intentional duplicate for Codex CLI compat.
- `initializeApp` uses `global.__appSingleton` to survive Next.js hot reload; registers SIGINT/SIGTERM cleanup for DNS & cloudflared.
- MITM server (`src/mitm/server.js`) binds port 443 (port 8443 on Windows); requires sudo/admin for DNS hosts-file edits.
- MITM manager (`src/mitm/manager.js`) is CJS; ESM bootstrap in `initializeApp.js` injects `process.env.MITM_SERVER_PATH` and calls `initDbHooks`.
- MITM server.js is copied from `node_modules` to `DATA_DIR/runtime/mitm/` at startup to avoid locking the install dir.
- OAuth client secrets moved to env vars: `GEMINI_OAUTH_CLIENT_SECRET`, `IFLOW_OAUTH_CLIENT_SECRET`, `ANTIGRAVITY_OAUTH_CLIENT_SECRET` (see `docs/SECRETS.md`).
- `src/store/`: zustand stores for UI state (provider, settings, theme, user, notification, headerSearch).
- `src/i18n/`: runtime i18n with config + React provider.

## DB & data dir
- SQLite driver order (`src/lib/db/driver.js`): Bun `bun:sqlite` → `better-sqlite3` → Node `node:sqlite` (≥22.5) → `sql.js` (fallback).
- `better-sqlite3` is **optionalDependency** (native build may fail; sql.js fallback at runtime).
- Data directory: `DATA_DIR` env or `~/.9router` (Windows `%APPDATA%\9router`). Unwritable `DATA_DIR` falls back to default (`src/lib/dataDir.js`).
- Docker sets `DATA_DIR=/app/data`.
- **usageDb stores at `~/.9router/usage.json` and `~/.9router/log.txt` — does NOT follow `DATA_DIR`** (known architectural issue).

## Webpack config quirks (next.config.mjs)
- `serverExternalPackages`: `better-sqlite3`, `sql.js`, `node:sqlite`, `bun:sqlite`, `node-forge`, `ssh2`, `node-ssh`.
- Server-side: deletes `crypto` alias from resolve to force native Node.js crypto.
- Client-side fallbacks: `fs: false`, `path: false`, `crypto: false`.
- Watcher ignores `logs`, `.next`, `gitbook`, `cli`.

## Tunnel & env
- Tunnel manager: `src/lib/tunnel/tunnelManager.js` + `src/lib/tunnel/cloudflared.js`; Tailscale auto-resumes from settings.
- Public domain: `PUBLIC_DOMAIN` or `TUNNEL_PUBLIC_DOMAIN` (default `9router.com`).
- Worker URL: `TUNNEL_WORKER_URL` (default `https://9router.com`).
- Full env var list: `.env.build`.

## CI / release
- Docker: push to GHCR + Docker Hub on `v*` tag or manual dispatch (`.github/workflows/docker-publish.yml`); Node 22-alpine, multi-platform (amd64/arm64).
- GitBook: deploy on changes under `gitbook/` (`.github/workflows/gitbook-pages.yml`); Node 24; pushes static export to external `9router/9router.github.io` repo.
- NPM publish: triggered by GitHub Release (`.github/workflows/npm-publish.yml`); Node 20; publishes root app (private — likely misconfigured), not `cli/`. The CLI is published manually via `cli/ $ npm run publish:cli`.
- Docker `output: "standalone"` bundles `.next/standalone`, `open-sse/`, `src/mitm/`, `src/shared/`, `src/lib/`, and native/wasm deps (`better-sqlite3`, `sql.js`, `node-forge`).

## Key source layout
- API routes: `src/app/api/v1/*` (compat), `src/app/api/*` (management), `src/app/api/oauth/*` (auth flows).
- SSE core: `src/sse/handlers/chat.js` (entry) → `open-sse/handlers/chatCore.js` (orchestration) → `open-sse/executors/*` (provider calls).
- Translator: `open-sse/translator/` (request/response format converters).
- Persistence: `src/lib/localDb.js` (config/state), `src/lib/usageDb.js` (usage history/logs).
- Security: `src/proxy.js` + `src/dashboardGuard.js` (dashboard auth middleware).
- Auth: `src/lib/auth/dashboardSession.js` (JWT), `src/lib/oauth/` (OAuth flows).
- Dashboard pages: `src/app/dashboard/`, `src/app/login/`, `src/app/landing/`.

## Git-ignored but present in working dir
- `package-lock.json`, `node_modules/` — standard.
- `docs/*` (except `docs/ARCHITECTURE.md`), `test/*`, `cloudflare/*` — intentionally gitignored.
- `data/`, `logs/`, `.bin/` — runtime artifacts.
