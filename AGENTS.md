# AGENTS.md

## What this repo is

- Next.js app (React 19) + API gateway/dashboard. Entry: `src/server-init.js` → `src/shared/services/initializeApp.js`.
- `open-sse/` separate provider/translator lib, imported via alias `open-sse/*` (`jsconfig.json`).

## Commands (don’t guess)

```bash
npm run dev        # next dev --webpack --port 20128
npm run build      # NODE_ENV=production next build --webpack
npm start          # NODE_ENV=production next start

npm run dev:bun
npm run build:bun
npm run start:bun  # runs ./.next/standalone/server.js

npx eslint .
```

- Port **20128** hardcoded in scripts + many defaults; change requires code edits, not env.
- No repo-defined `npm test` script, but `.github/workflows/npm-publish.yml` runs `npm test` (CI will fail unless workflow updated or script added).

## Runtime wiring (high-signal entrypoints)

- Startup orchestration: `src/shared/services/initializeApp.js`
- injects `process.env.MITM_SERVER_PATH` if missing
- auto-resume tunnel/tailscale once per process based on DB settings
- registers SIGINT/SIGTERM cleanup (DNS + cloudflared)
- Tunnel: `src/lib/tunnel/tunnelManager.js` + `src/lib/tunnel/cloudflared.js`
- public URL uses `PUBLIC_DOMAIN` or `TUNNEL_PUBLIC_DOMAIN` (default `9router.com`)
- worker endpoint `TUNNEL_WORKER_URL` (default `https://9router.com`)
- MITM: `src/mitm/manager.js` (CJS) spawns `src/mitm/server.js`
- server controlled by env passed at spawn: `ROUTER_API_KEY`, `MITM_ROUTER_BASE`

## DB layer gotchas

- SQLite driver fallback order (runtime): bun sqlite → better-sqlite3 (optional dep) → node:sqlite → sql.js.
- Selector: `src/lib/db/driver.js`.
- Data dir resolved from `DATA_DIR` (else `~/.9router` or `%APPDATA%\9router`). Logic duplicated in `src/lib/dataDir.js` + `src/mitm/paths.js`.

## Docker quirks

- `next.config.mjs` sets `output: "standalone"`; Dockerfile copies extra dirs into standalone output: `open-sse/`, `src/mitm/`, `src/shared/`, `src/lib/`.
- Container defaults: `PORT=20128`, `DATA_DIR=/app/data` (`Dockerfile`).

## CI/release signals

- Docker image publish on git tag `v*`: `.github/workflows/docker-publish.yml`.
- NPM publish on GitHub Release create: `.github/workflows/npm-publish.yml`.
