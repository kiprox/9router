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

function isModuleMissing(error) {
  const code = String(error?.code || "");
  return code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND";
}

function npmInstall(pkg, version) {
  const cwd = getRuntimeDir();
  fs.mkdirSync(cwd, { recursive: true });
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
  try {
    return await runtimeImport(pathToFileURL(runtimeRequire.resolve(pkg)).href);
  } catch (error) {
    if (!isModuleMissing(error)) throw error;
  }
  // 3) Download on demand, then import from the runtime dir.
  const version = LAZY_DEP_VERSIONS[pkg] || "latest";
  const dir = getRuntimeDir();
  const res = await npmInstall(pkg, version);
  if (!res.ok) {
    const reason = (res.stderr.match(/npm ERR! ?(.+)/) || [])[1] || res.stderr.split("\n").filter(Boolean).pop() || "unknown npm error";
    throw new Error(
      `${pkg} is missing and the on-demand install failed (${String(reason).slice(0, 160)}) — ` +
      `install it manually: cd "${dir}" && npm install ${pkg}@${version}`
    );
  }
  return runtimeImport(pathToFileURL(createRequire(path.join(dir, "package.json")).resolve(pkg)).href);
}

export function loadRuntimeDep(pkg) {
  if (!inflight.has(pkg)) {
    inflight.set(pkg, load(pkg).finally(() => inflight.delete(pkg)));
  }
  return inflight.get(pkg);
}
