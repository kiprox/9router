// Lazy loader for heavy optional runtime deps (playwright-core, wreq-js).
//
// They are devDependencies only, so end-user installs stay small. On first
// use the package is downloaded into <DATA_DIR>/runtime (same pattern as
// cli/hooks/sqliteRuntime.js) and imported from there. Resolution order:
// app node_modules (dev / traced standalone) → runtime dir → npm install.
//
// Never throws at import time of THIS module — failures surface from
// loadRuntimeDep() with a manual-install hint.
//
// Webpack hardening (the server bundler rewrites every obvious form):
//   - a static `node:module` import is stubbed, so `createRequire` is fetched
//     with a runtime import instead (getCreateRequire below). Called directly,
//     `createRequire(<computed>)` is additionally rewritten by
//     CommonJsImportsParserPlugin into `/* createRequire() */ undefined`, so
//     every resolve() threw "Cannot read properties of undefined (reading
//     'resolve')" in the standalone/Docker build while dev worked.
//   - `import(<computed>)` becomes a webpackEmptyAsyncContext that always
//     throws MODULE_NOT_FOUND, so runtime-dir loads could never succeed; every
//     runtime import below carries `webpackIgnore: true` for that reason.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getWritableDataDir } from "../utils/writableDataDir.js";

// Keep in sync with package.json devDependencies.
const LAZY_DEP_VERSIONS = {
  "playwright-core": "^1.62.1",
  "wreq-js": "^3.2.0",
};

function getRuntimeDir() {
  return path.join(getWritableDataDir(), "runtime");
}

// A static node:module import gets stubbed by the server bundler, so
// createRequire must be fetched at runtime for published builds to work.
let createRequirePromise;
function getCreateRequire() {
  createRequirePromise ??= import(/* webpackIgnore: true */ "node:module").then((mod) => mod.createRequire);
  return createRequirePromise;
}

function isModuleMissing(error) {
  const code = String(error?.code || "");
  return code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND";
}

// npm 7+ prints `npm ERR!`, npm 11+ switched to `npm error`. Matching only the
// former left every modern-npm failure falling through to "the last line",
// which is the debug-log pointer — the real cause (EACCES, ENOTFOUND, ETARGET)
// was thrown away. Skip that pointer and surface the first meaningful
// diagnostic instead.
function summarizeNpmError(stderr = "") {
  const lines = String(stderr)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    // `npm error A complete log of this run can be found in:` carries no cause.
    .filter((line) => !/A complete log of this run/i.test(line))
    .map((line) => line.replace(/^npm (?:ERR!|error)\s*/, "").trim())
    .filter(Boolean);
  if (!lines.length) return "unknown npm error";
  // `code EACCES` / `Error: EACCES ...` is the most useful single line.
  const codeLine = lines.find((line) => /^(code|errno)\s+[A-Z_-]+/i.test(line));
  const errorLine = lines.find((line) => /^Error:\s/.test(line));
  return String(codeLine || errorLine || lines[0]).slice(0, 200);
}

function npmInstall(pkg, version) {
  const cwd = getRuntimeDir();
  fs.mkdirSync(cwd, { recursive: true });
  // Anchor npm to the runtime dir so it can't adopt a parent package.json as install root.
  const manifest = path.join(cwd, "package.json");
  if (!fs.existsSync(manifest)) {
    fs.writeFileSync(manifest, JSON.stringify({ name: "9router-runtime", private: true }, null, 2));
  }
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const args = ["install", "--no-audit", "--no-fund", "--prefer-online", `${pkg}@${version}`];
  return new Promise((resolve) => {
    const child = spawn(npm, args, { cwd, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => resolve({ ok: false, stderr: String(error.message || error) }));
    child.on("close", (status) => resolve({ ok: status === 0, stderr }));
  });
}

async function installIntoRuntime(pkg, version) {
  const dir = getRuntimeDir();
  const res = await npmInstall(pkg, version);
  if (!res.ok) {
    throw new Error(
      `${pkg} is missing and the on-demand install failed (${summarizeNpmError(res.stderr)}) — ` +
      `install it manually: cd "${dir}" && npm install ${pkg}@${version}`
    );
  }
}

const inflight = new Map();

// createRequire.resolve applies the CJS "require" condition, which returns the
// CJS entry for packages that ship both (playwright-core: require→index.js,
// import→index.mjs). Prefer the ESM entry so named exports survive the file-URL
// import below.
function resolveRuntimeEntry(runtimeRequire, pkg) {
  try {
    return runtimeRequire.resolve(pkg, { conditions: ["import"] });
  } catch {
    return runtimeRequire.resolve(pkg);
  }
}

// Importing a CJS entry via file URL bypasses the exports map, and
// cjs-module-lexer cannot detect named exports through chained re-exports
// (`module.exports = require('./coreBundle').inprocess.playwright`), so
// consumers destructuring `{ chromium }` get undefined. Merge `default`'s
// own properties as a fallback.
function unwrapCjsNamespace(mod) {
  if (mod?.default && typeof mod.default === "object") {
    return { ...mod.default, ...mod };
  }
  return mod;
}

async function load(pkg) {
  // 1) Resolvable from the app install (dev machine / traced standalone).
  try {
    return await import(/* webpackIgnore: true */ /* @vite-ignore */ pkg);
  } catch (error) {
    if (!isModuleMissing(error)) throw error;
  }
  // 2) Already present in the runtime dir from a previous install.
  const createRequire = await getCreateRequire();
  const runtimeRequire = createRequire(path.join(getRuntimeDir(), "package.json"));
  try {
    const entry = resolveRuntimeEntry(runtimeRequire, pkg);
    return unwrapCjsNamespace(await import(/* webpackIgnore: true */ /* @vite-ignore */ pathToFileURL(entry).href));
  } catch (error) {
    if (!isModuleMissing(error)) throw error;
  }
  // 3) Download on demand, then import from the runtime dir.
  const version = LAZY_DEP_VERSIONS[pkg] || "latest";
  const runtimeImport = async () =>
    unwrapCjsNamespace(await import(/* webpackIgnore: true */ /* @vite-ignore */ pathToFileURL(resolveRuntimeEntry(runtimeRequire, pkg)).href));
  await installIntoRuntime(pkg, version);
  try {
    return await runtimeImport();
  } catch (error) {
    // npm exits 0 even on partially-extracted installs; wipe and retry once.
    if (!isModuleMissing(error)) throw error;
    fs.rmSync(path.join(getRuntimeDir(), "node_modules", pkg), { recursive: true, force: true });
    await installIntoRuntime(pkg, version);
    return runtimeImport();
  }
}

export function loadRuntimeDep(pkg) {
  if (!inflight.has(pkg)) {
    inflight.set(pkg, load(pkg).finally(() => inflight.delete(pkg)));
  }
  return inflight.get(pkg);
}
