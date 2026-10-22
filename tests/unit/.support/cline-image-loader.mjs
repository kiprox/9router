// Loader for tests/unit/cline-image-adapter.test.js: the shared alias loader
// (jsconfig `@/…` → src/) plus a stub for `@/lib/db`.
//
// The cline image adapter posts through the real DefaultExecutor, whose import
// chain reaches the storage layer. These tests assert on request/response
// mapping, not storage, and must not open DATA_DIR/db/data.sqlite. Everything
// else resolves exactly like open-sse-alias-loader.mjs.
//
// Not a test file (no *.test.js suffix) — never pass it to `node --test` as a
// positional argument.
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, "../../../src");
const USAGE_DB_STUB = fileURLToPath(new URL("./usageDbStub.js", import.meta.url));
const DB_STUB = fileURLToPath(new URL("./dbStub.js", import.meta.url));

function resolveSrc(spec) {
  const base = resolve(SRC, spec);
  for (const candidate of [base, `${base}.js`, join(base, "index.js")]) {
    if (candidate.endsWith(".js") && existsSync(candidate)) return pathToFileURL(candidate).href;
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/usageDb.js") return { url: pathToFileURL(USAGE_DB_STUB).href, shortCircuit: true };
    if (specifier === "@/lib/db" || specifier === "@/lib/db/index.js") {
      return { url: pathToFileURL(DB_STUB).href, shortCircuit: true };
    }
    if (specifier.startsWith("@/")) {
      const resolved = resolveSrc(specifier.slice(2));
      if (resolved) return { url: resolved, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
