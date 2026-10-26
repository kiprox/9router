// The lazy runtime loader is the one path that must survive webpack. Both of
// its resolution steps used to be rewritten at build time, so the Docker /
// standalone image threw `Cannot read properties of undefined (reading
// 'resolve')` on every OpenCode free-tier request while `npm run dev` worked:
//
//   1. `createRequire(<computed>)` -> `/* createRequire() */ undefined`
//      (CommonJsImportsParserPlugin, because the argument is not a literal)
//   2. `import(<computed>)` -> webpackEmptyAsyncContext, which always throws
//      MODULE_NOT_FOUND, so a runtime-dir install could never be loaded.
//
// These tests read the emitted bundle when one exists (post-build) and always
// assert the source keeps the hardened forms that produce correct output.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const sourceUrl = new URL("../../open-sse/services/lazyRuntime.js", import.meta.url);
const source = readFileSync(sourceUrl, "utf-8");

// Comments describe the very patterns asserted against below, so strip them
// first or the docblock matches its own warning. `webpackIgnore` is preserved
// because it is a magic comment the assertions depend on.
const code = source
  .replace(/\/\*(?!\s*webpackIgnore)[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("lazyRuntime bundler hardening (source)", () => {
  it("never imports createRequire as a named binding", () => {
    // webpack rewrites a named `createRequire(...)` call into
    // `/* createRequire() */ undefined`; the alias below cannot be rewritten.
    expect(code).not.toMatch(/import\s*\{[^}]*\bcreateRequire\b[^}]*\}\s*from\s*["']node:module["']/);
  });

  it("takes createRequire off the node:module default binding", () => {
    expect(code).toMatch(/import\s+nodeModule\s+from\s+["']node:module["']/);
    expect(code).toMatch(/const\s+createRequire\s*=\s*nodeModule\.createRequire/);
  });

  it("routes every dynamic import through one webpackIgnore helper", () => {
    const helper = code.match(/const\s+runtimeImport\s*=[^;]*webpackIgnore[^;]*;/);
    expect(helper).toBeTruthy();
    // Any other `import(` would be compiled to an empty async context again.
    const others = code.replace(helper[0], "").match(/[^.\w]import\s*\(/g) || [];
    expect(others).toHaveLength(0);
  });
});

// Only meaningful after `npm run build`, and only when that build is newer than
// the loader — otherwise it would assert against a stale artifact from before
// the fix and fail for the wrong reason.
const distDir = process.env.NEXT_DIST_DIR || ".next";
const chunkDir = new URL(`../../${distDir}/server/chunks/`, import.meta.url);

function bundleIsCurrent() {
  if (!existsSync(chunkDir)) return false;
  const sourceMtime = statSync(sourceUrl).mtimeMs;
  return readdirSync(chunkDir)
    .filter((name) => name.endsWith(".js"))
    .some((name) => {
      const file = join(chunkDir.pathname, name);
      const stat = statSync(file);
      return stat.mtimeMs >= sourceMtime && readFileSync(file, "utf-8").includes("on-demand install failed");
    });
}

describe.skipIf(!bundleIsCurrent())("lazyRuntime bundler hardening (emitted bundle)", () => {
  const loaderChunks = readdirSync(chunkDir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => join(chunkDir.pathname, name))
    .filter((file) => readFileSync(file, "utf-8").includes("on-demand install failed"));

  it("emits the loader without the undefined-createRequire rewrite", () => {
    expect(loaderChunks.length).toBeGreaterThan(0);
    for (const file of loaderChunks) {
      // The exact signature from the bug report.
      expect(readFileSync(file, "utf-8")).not.toContain("(void 0).resolve");
    }
  });

  it("keeps the runtime import as a real import, not an empty async context", () => {
    for (const file of loaderChunks) {
      const text = readFileSync(file, "utf-8");
      const loader = text.slice(text.indexOf("on-demand install failed") - 1200, text.indexOf("on-demand install failed"));
      // webpackEmptyAsyncContext only ever throws MODULE_NOT_FOUND, so its
      // presence inside the loader body means the runtime-dir step is dead.
      expect(loader).not.toMatch(/webpackEmptyAsyncContext\s*\(\s*\w+\s*\)/);
    }
  });
});
