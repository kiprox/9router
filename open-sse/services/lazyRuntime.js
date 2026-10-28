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
// Webpack hardening (both needed, the bundler rewrites the obvious forms):
//   - `createRequire(...)` called directly is statically rewritten by
//     CommonJsImportsParserPlugin into `/* createRequire() */ undefined`
//     because its argument is computed, so every resolve() threw
//     "Cannot read properties of undefined (reading 'resolve')" in the
//     standalone/Docker build while dev worked. Pulling the function off the
//     `node:module` default binding leaves a plain member expression webpack
//     does not touch.
//   - `import(<computed>)` becomes a webpackEmptyAsyncContext that always
//     throws MODULE_NOT_FOUND, so runtime-dir loads could never succeed.
//     Funnel it through one `webpackIgnore` helper so the specifier stays a
//     real runtime import.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import nodeModule from "node:module";
import { pathToFileURL } from "node:url";
import { getWritableDataDir } from "../utils/writableDataDir.js";

// Keep in sync with package.json devDependencies.
const LAZY_DEP_VERSIONS = {
  "playwright-core": "^1.62.1",
  "wreq-js": "^3.2.0",
};

// Member expression off the builtin's default export: not rewritten by webpack.
const createRequire = nodeModule.createRequire;

// Real runtime import (specifier is only known at call time). Keeping this in
// one place stops the bundler from turning it into an empty async context.
const runtimeImport = (specifier) => import(/* webpackIgnore: true */ specifier);

function getRuntimeDir() {
  return path.join(getWritableDataDir(), "runtime");
}

// npm resolves the project root by walking UP from cwd until it finds a
// package.json. DATA_DIR (/app/data) sits inside the app tree, so without its
// own package.json the runtime dir inherits /app/package.json: npm installs
// into /app/node_modules and rewrites the app's dependencies. In the Docker
// image /app is root-owned while the server runs as `node`, which surfaced as
// "EACCES: mkdir '/app/node_modules'" and left the optional dep uninstallable.
function ensureRuntimeProject() {
  const dir = getRuntimeDir();
  fs.mkdirSync(dir, { recursive: true });
  const pkgPath = path.join(dir, "package.json");
  if (!fs.existsSync(pkgPath)) {
    fs.writeFileSync(pkgPath, JSON.stringify({
      name: "9router-runtime",
      version: "1.0.0",
      private: true,
      description: "User-writable runtime deps (playwright-core, wreq-js) installed on demand",
    }, null, 2));
  }
  return dir;
}

function isModuleMissing(error) {
  const code = String(error?.code || "");
  return code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND";
}

// npm 7+ prints `npm ERR!`, npm 11+ switched to `npm error`. The old regex only
// matched the former, so on modern npm every failure fell through to "the last
// line", which is the debug-log pointer — the real cause (EACCES, ENOTFOUND,
// ETARGET) was thrown away. Skip that pointer and surface the first meaningful
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
  const cwd = ensureRuntimeProject();
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
  const dir = ensureRuntimeProject();
  const res = await npmInstall(pkg, version);
  if (!res.ok) {
    throw new Error(
      `${pkg} is missing and the on-demand install failed (${summarizeNpmError(res.stderr)}) — ` +
      `install it manually: cd "${dir}" && npm install ${pkg}@${version}`
    );
  }
}

const inflight = new Map();

async function load(pkg) {
  // 1) Resolvable from the app install (dev machine / traced standalone).
  try {
    return await runtimeImport(pkg);
  } catch (error) {
    if (!isModuleMissing(error)) throw error;
  }
  // 2) Already present in the runtime dir from a previous install.
  const runtimeRequire = createRequire(path.join(getRuntimeDir(), "package.json"));
  const importFromRuntime = () => runtimeImport(pathToFileURL(runtimeRequire.resolve(pkg)).href);
  try {
    return await importFromRuntime();
  } catch (error) {
    if (!isModuleMissing(error)) throw error;
  }
  // 3) Download on demand, then import from the runtime dir.
  const version = LAZY_DEP_VERSIONS[pkg] || "latest";
  await installIntoRuntime(pkg, version);
  try {
    return await importFromRuntime();
  } catch (error) {
    // npm exits 0 even on partially-extracted installs; wipe and retry once.
    if (!isModuleMissing(error)) throw error;
    fs.rmSync(path.join(getRuntimeDir(), "node_modules", pkg), { recursive: true, force: true });
    await installIntoRuntime(pkg, version);
    return importFromRuntime();
  }
}

export function loadRuntimeDep(pkg) {
  if (!inflight.has(pkg)) {
    inflight.set(pkg, load(pkg).finally(() => inflight.delete(pkg)));
  }
  return inflight.get(pkg);
}