// Loader flags equivalent to tests/unit/.support/open-sse-alias-hooks.mjs, for the
// `node --test --import` CLI form where in-process registerHooks() is not applied
// to the synchronous module linker.
//
// Not a test file (no *.test.js suffix). Do not pass it to `node --test` as a
// positional argument — that would run it as a test.
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../../src");
const USAGE_DB_STUB = fileURLToPath(new URL("./usageDbStub.js", import.meta.url));

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
    if (specifier.startsWith("@/")) {
      const resolved = resolveSrc(specifier.slice(2));
      if (resolved) return { url: resolved, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
