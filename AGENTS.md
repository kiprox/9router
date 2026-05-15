# AGENTS.md

## Investigation steps
- Read top‑level `README*`, `package.json`, lockfiles.
- Inspect build, lint, typecheck scripts in `package.json` and `.github/workflows/*`.
- Review existing instruction files (`AGENTS.md`, `CLAUDE.md`, `.cursor/*`).
- If architecture still unclear, open entrypoints: `src/server-init.js`, `src/shared/services/initializeApp.js`.

## Repo shape
- Root: private Next.js app (React 19) serving API gateway/dashboard. Startup `src/server-init.js → src/shared/services/initializeApp.js`.
- `open-sse/`: provider/translator lib, imported via alias `open-sse/*` (see `jsconfig.json`).
- `gitbook/`: independent Next.js docs site, own `package.json`; CI builds only this folder.
- `cli/`: published CLI, own `package.json` and build/publish scripts.

## Commands
```bash
npm run dev        # next dev --webpack --port 20128
npm run build      # NODE_ENV=production next build --webpack
npm start          # NODE_ENV=production next start
npm run dev:bun    # bun --bun next dev --webpack --port 20128
npm run build:bun  # NODE_ENV=production bun --bun next build --webpack
npm run start:bun  # NODE_ENV=production bun ./.next/standalone/server.js
npx eslint .
```
- No root `npm test`; CI still runs `npm test` (fails). Add test script if needed.
- `gitbook`: `npm run dev` (port 3001), `npm run build` (static export).
- `cli`: `npm run build`, `npm run pack:cli`, `npm run publish:cli`; postinstall installs runtime deps under `~/.9router/runtime/node_modules`.

## Runtime gotchas
- Port `20128` hard‑coded in scripts and Dockerfile; change both.
- `next.config.mjs` contains `DO NOT CHANGE - dont stage this` note.
- Next builds standalone; Dockerfile copies `open-sse/`, `src/mitm/`, `src/shared/`, `src/lib/`, required native/wasm deps.
- Docker uses Node 22‑alpine; CI uses Node 20 (npm publish) and Node 24 (GitBook).
- Rewrites: `/v1/*` & `/codex/*` → `/api/v1/*`; duplicate `/v1/v1/*` intentional.
- `initializeApp` uses singleton to survive hot reload; registers SIGINT/SIGTERM cleanup for DNS & cloudflared.

## DB & data dir
- SQLite driver order (`src/lib/db/driver.js`): Bun `bun:sqlite` → `sql.js`; optional `better-sqlite3`; Node built‑in `node:sqlite` (≥22.5) → fallback `sql.js`.
- Data directory: `DATA_DIR` env or `~/.9router` (Windows `%APPDATA%\9router`). Unwritable `DATA_DIR` falls back to default (`src/lib/dataDir.js`).

## MITM & tunnel
- MITM manager CJS (`src/mitm/manager.js`) spawns `src/mitm/server.js`; ESM bootstrap injects `process.env.MITM_SERVER_PATH`.
- Tunnel manager `src/lib/tunnel/tunnelManager.js` + `src/lib/tunnel/cloudflared.js`; Tailscale auto‑resumes from settings.
- Public domain: `PUBLIC_DOMAIN` or `TUNNEL_PUBLIC_DOMAIN` (default `9router.com`).
- Worker URL: `TUNNEL_WORKER_URL` (default `https://9router.com`).

## CI / release
- Docker image publish on tag `v*` or manual dispatch (`.github/workflows/docker-publish.yml`).
- GitBook deploy on changes under `gitbook/` (`.github/workflows/gitbook-pages.yml`).
- NPM publish on GitHub Release (`.github/workflows/npm-publish.yml`); currently publishes root app, not `cli/`.
