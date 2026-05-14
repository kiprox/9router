# AGENTS.md

## Repo shape

- Root: Next.js app (React 19) + API gateway/dashboard. Startup: `src/server-init.js` → `src/shared/services/initializeApp.js`.
- `open-sse/`: provider/translator lib; import via alias `open-sse/*` (`jsconfig.json`).
- `gitbook/`: separate Next.js docs app (own `package.json`), CI builds from `gitbook/` only.
- `cli/`: published npm CLI (own `package.json`, own build/publish scripts).

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

- No root `npm test` script exists; `.github/workflows/npm-publish.yml` still runs `npm test` on GitHub Release.
- `gitbook`: `npm run dev` serves port `3001`; `npm run build` builds static export used by GitHub Pages CI.
- `cli`: `npm run build`, `npm run pack:cli`, `npm run publish:cli`; postinstall installs runtime deps under `~/.9router/runtime/node_modules`.

## Runtime wiring / gotchas

- Port `20128` appears in root scripts and Dockerfile `PORT`/`EXPOSE`; changing port is cross-file.
- `next.config.mjs` has repo note `DO NOT CHANGE - dont stage this`; avoid editing unless user explicitly asks.
- Next output is `standalone`; Dockerfile manually copies `open-sse/`, `src/mitm/`, `src/shared/`, `src/lib/`, selected native/wasm deps into runtime.
- Rewrites in `next.config.mjs`: `/v1/*` and `/codex/*` map into `/api/v1/*`; duplicate `/v1/v1/*` routes are intentional config.
- `initializeApp` uses global singleton to survive Next dev hot reload; registers SIGINT/SIGTERM cleanup for DNS + cloudflared.

## DB + data dir

- SQLite driver order (`src/lib/db/driver.js`): Bun `bun:sqlite` → `sql.js`; Node `better-sqlite3` (optional dep) → `node:sqlite` (Node ≥22.5) → `sql.js`.
- Data dir: `DATA_DIR` else `~/.9router` (or `%APPDATA%\9router`); unwritable `DATA_DIR` falls back to default (`src/lib/dataDir.js`).

## MITM / tunnel

- MITM manager is CJS: `src/mitm/manager.js` spawns `src/mitm/server.js`; ESM bootstrap injects `process.env.MITM_SERVER_PATH` in `src/shared/services/initializeApp.js`.
- Tunnel: `src/lib/tunnel/tunnelManager.js` + `src/lib/tunnel/cloudflared.js`; Tailscale also auto-resumes from settings.
- Public URL domain: `PUBLIC_DOMAIN` or `TUNNEL_PUBLIC_DOMAIN` (default `9router.com`).
- Worker endpoint: `TUNNEL_WORKER_URL` (default `https://9router.com`).

## CI/release

- Docker image publish on tag `v*` or manual dispatch: `.github/workflows/docker-publish.yml`.
- GitBook deploy on push to main/master touching `gitbook/**`: `.github/workflows/gitbook-pages.yml` (Node 24, working dir `gitbook`).
- NPM publish on GitHub Release created: `.github/workflows/npm-publish.yml` (Node 20, root `npm ci`, `npm test`, `npm publish`).
