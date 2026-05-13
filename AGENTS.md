# AGENTS.md

## Repo shape

- Root: Next.js app (React 19) + API gateway/dashboard. Startup: `src/server-init.js` → `src/shared/services/initializeApp.js`.
- `open-sse/`: provider/translator lib; import via alias `open-sse/*` (`jsconfig.json`).
- `gitbook/`: separate Next.js docs app; CI builds from `gitbook/` only.
- `cli/`: published npm CLI (different package.json, own build scripts).

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

- No root `npm test` script, but `.github/workflows/npm-publish.yml` runs `npm test`.
- Port `20128` hardcoded in scripts (also Dockerfile env). Changing port needs code/script edits.

## Runtime wiring / gotchas

- Next output `standalone` (`next.config.mjs`). Dockerfile copies extra dirs into runtime: `open-sse/`, `src/mitm/`, `src/shared/`, `src/lib/`.
- Rewrites in `next.config.mjs`: `/v1/*` and `/codex/*` map into `/api/v1/*` (note duplicate `/v1/v1/*` rules).
- `initializeApp` uses global singleton to survive Next dev hot reload; registers SIGINT/SIGTERM cleanup (DNS + cloudflared).

## DB + data dir

- SQLite driver order (`src/lib/db/driver.js`):
  - Bun: `bun:sqlite` → `sql.js`
  - Node: `better-sqlite3` (optional dep) → `node:sqlite` (Node ≥22.5) → `sql.js`
- Data dir: `DATA_DIR` else `~/.9router` (or `%APPDATA%\9router`); fallback to default if `DATA_DIR` not writable (`src/lib/dataDir.js`).

## MITM / tunnel

- MITM manager is CJS: `src/mitm/manager.js` spawns `src/mitm/server.js`; ESM bootstrap injects `process.env.MITM_SERVER_PATH` in `src/shared/services/initializeApp.js`.
- Tunnel: `src/lib/tunnel/tunnelManager.js` + `src/lib/tunnel/cloudflared.js`.
- Public URL domain: `PUBLIC_DOMAIN` or `TUNNEL_PUBLIC_DOMAIN` (default `9router.com`).
- Worker endpoint: `TUNNEL_WORKER_URL` (default `https://9router.com`).

## CI/release

- Docker image publish on tag `v*`: `.github/workflows/docker-publish.yml`.
- GitBook deploy on push to main/master touching `gitbook/**`: `.github/workflows/gitbook-pages.yml`.
- NPM publish on GitHub Release created: `.github/workflows/npm-publish.yml`.
