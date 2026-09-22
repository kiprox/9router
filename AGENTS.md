# AGENTS.md

## Repo shape

- Root (`sirouter`, private): Next.js 16 + React 19 gateway + dashboard. Plain JS ESM, no TS. Aliases `@/*`→`src/*`, `open-sse/*` (`jsconfig.json`).
- `open-sse/`: provider routing/translation engine, no own `package.json`. Read `open-sse/AGENTS.md` before editing it; full request lifecycle in `docs/ARCHITECTURE.md`.
- `cli/` (`9router` on npm): separate package, esbuild via `scripts/build-cli.js`. Prefer root wrappers `npm run cli:pack` / `cli:publish`.
- `gitbook/`: separate docs site, static export to `out/`, Node 24.
- `cloudflare/worker/`: KV worker, Wrangler, deploys separately.
- `tests/unit/` + `tests/translator/`: bare `*.test.js` files — no `package.json`, no vitest/jest config, no root `npm test` script. CI `npm-publish.yml` still runs `npm test` and fails; ignore it, don't wire a runner unasked.

## Commands (repo root unless noted)

```bash
npm run dev            # next dev --port 20127 (no --webpack; dev:webpack adds it)
npm run build          # next build --webpack; postbuild copies static/public into standalone
npm run start          # node custom-server.js --port 20127 (stamps real-IP headers; bare next start/dev bypasses it)
npx eslint .           # flat config eslint.config.mjs (core-web-vitals)
npm run cli:pack       # or: cd cli && npm run build / pack:cli / publish:cli
(cd gitbook && npm run dev)  # -p 3001; build → static out/
# bun variants: dev:bun / build:bun / start:bun (serves ./.next/standalone/custom-server.js)
```

- `.env.build` is reference-only (never auto-loaded); local dev uses `.env.local` / env vars.
- Runtime port default is `20128` (`UPDATER_CONFIG.appPort` in `src/shared/constants/config.js`); Dockerfile sets `PORT=20128`.

## Init chain

```
src/app/layout.js (side-effect imports)
  → src/shared/services/bootstrap.js   (skips on NEXT_PHASE build, guards global.__appBootstrapped)
    → src/shared/services/initializeApp.js (state in global.__appSingleton, HMR-safe; watchdog, tunnel/Tailscale resume, MITM autostart)
```

## Gotchas

- Next 16 convention: auth is `src/proxy.js` (default `proxy`) + `src/dashboardGuard.js`. Do NOT rename to `middleware.js`.
- Rewrites (`next.config.mjs`): `/v1/*`→`/api/v1/*`, `/v1/v1/*` dup (Codex compat), `/codex/*`→`/api/v1/responses`, `/responses`→`/api/v1/responses`, `/v1beta/*` passthrough.
- `NEXT_PUBLIC_*` is build-time-only. Client truth for image builds is `APP_CONFIG.isDockerImage/imageSha` (`NEXT_PUBLIC_APP_IMAGE_SHA` or `SOURCE_COMMIT` fallback).
- `custom-server.js` derives client IP from the TCP socket → `x-9r-real-ip` + `x-9r-peer-token`, strips `XFF`/`x-real-ip` unless loopback proxy (also downgrades h2c upgrades). IP/rate-limit code must read `x-9r-real-ip`, never trust `XFF`.
- MITM (`src/mitm/`): port 443 (8443 on Windows), needs sudo/admin for hosts-file DNS. Only the `node_modules`-bundled `server.js` is copied to `DATA_DIR/runtime/mitm/` (published CLI case); dev runs from source.
- `next.config.mjs`: keep `open` in `serverExternalPackages` (webpack rewrites its `import.meta.url`, breaking OAuth imports on Windows); server deletes `crypto` alias, client sets `fs/path/crypto: false`; `output: standalone`. `NEXT_TRACING_ROOT_MODE=workspace` only for CLI bundling.
- DB (`src/lib/db/`): Node order is better-sqlite3 (skipped on Node ≥24, SIGSEGV) → `node:sqlite` (≥22.5) → `sql.js`; Bun is `bun:sqlite` → `sql.js`. `better-sqlite3` is optional. File is `DATA_DIR/db/data.sqlite`. `localDb.js`/`usageDb.js` are shims — new code imports `@/lib/db/index.js`, entities in `lib/db/repos/*`.
- `DATA_DIR` env else `~/.9router` (`%APPDATA%\9router` on Windows; Unix-style paths ignored on Windows). Docker sets `DATA_DIR=/app/data`.
- Layout: compat APIs `src/app/api/v1/*`, management `src/app/api/*`, OAuth `src/app/api/oauth/*`; chat `src/sse/handlers/chat.js` → `open-sse/handlers/chatCore.js` → `executors/*`; dashboard `src/app/(dashboard)/dashboard/`; zustand stores `src/store/`.
- CLI `postinstall` lazy-installs sql.js/better-sqlite3/systray2 into `~/.9router/runtime/node_modules` (avoids EBUSY/AV false positives). Tray: systray2 fork on macOS/Linux, PowerShell `NotifyIcon` on Windows. Engines: node ≥18.
- Docker runner copies only `public`, `.next/static`+`standalone`, `custom-server.js`, `open-sse`, `src/{mitm,shared,lib}`, plus `node_modules/{better-sqlite3,node-forge,next,sql.js,node-machine-id}`; CMD `node server.js`. Multi-arch push on `v*` tag.
- CI: `docker-publish.yml` (`v*`/dispatch); `gitbook-pages.yml` (push to main/master touching `gitbook/**`, force-orphan to `9router/9router.github.io`); `npm-publish.yml` (release; broken `npm test` — ignore, publish CLI manually).
