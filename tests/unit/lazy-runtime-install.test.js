// The on-demand installer has two failure modes that only appear in the
// container, where DATA_DIR (/app/data) is nested inside a root-owned app tree:
//
//   1. npm walks UP from cwd looking for a project root. With no package.json
//      in <DATA_DIR>/runtime it adopted /app/package.json, installed into
//      /app/node_modules and rewrote the app's dependency list. /app is
//      root-owned while the server runs as `node`, so the install died with
//      "EACCES: mkdir '/app/node_modules'" and the dep was never available.
//   2. npm 11+ prints `npm error`, not `npm ERR!`. The old regex missed it and
//      fell back to the last stderr line, which is the debug-log pointer — so
//      the report said nothing about EACCES and looked like a network problem.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

let root;
let spawnCwd;

// wreq-js resolves from the repo's own devDependencies, so the loader would
// short-circuit before installing. A name that cannot resolve anywhere forces
// the install path these tests are about.
const MISSING_PKG = "9router-lazy-runtime-probe";

beforeEach(() => {
  vi.resetModules();
  spawnMock.mockReset();
  spawnCwd = null;
  root = mkdtempSync(join(tmpdir(), "lazy-runtime-"));
  // Must be writable: getWritableDataDir() falls back to ~/.9router otherwise,
  // and its cache is module-level (survives vi.resetModules).
  mkdirSync(join(root, "data"), { recursive: true });
  process.env.DATA_DIR = join(root, "data");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

// Fake npm: records the cwd it ran in and reports the given stderr.
function fakeNpm({ status = 0, stderr = "" } = {}) {
  spawnMock.mockImplementation((cmd, args, options) => {
    spawnCwd = options.cwd;
    const handlers = {};
    return {
      stderr: { on: (event, handler) => { if (event === "data" && stderr) handler(stderr); } },
      on: (event, handler) => {
        handlers[event] = handler;
        if (event === "close") queueMicrotask(() => handler(status));
      },
    };
  });
}

describe("runtime project isolation", () => {
  it("pins the runtime dir as its own npm project root", async () => {
    // The container shape: DATA_DIR inside a root-owned app tree.
    mkdirSync(join(root, "data"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "sirouter", version: "0.5.111" }));
    fakeNpm({ status: 1, stderr: "npm error code EACCES" });

    const { loadRuntimeDep } = await import("../../open-sse/services/lazyRuntime.js");
    await loadRuntimeDep(MISSING_PKG).catch(() => {});

    // npm must run inside <DATA_DIR>/runtime, never the app root — otherwise it
    // resolves /app/package.json and installs into root-owned /app/node_modules.
    expect(spawnMock).toHaveBeenCalled();
    expect(spawnCwd).toBe(join(root, "data", "runtime"));

    const pkgPath = join(root, "data", "runtime", "package.json");
    expect(existsSync(pkgPath)).toBe(true);
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    expect(pkg.private).toBe(true);
  });

  it("leaves the application package.json untouched", async () => {
    mkdirSync(join(root, "data"), { recursive: true });
    const appPkg = join(root, "package.json");
    const before = JSON.stringify({ name: "sirouter", version: "0.5.111", private: true });
    writeFileSync(appPkg, before);
    fakeNpm({ status: 1, stderr: "npm error code EACCES" });

    const { loadRuntimeDep } = await import("../../open-sse/services/lazyRuntime.js");
    await loadRuntimeDep(MISSING_PKG).catch(() => {});

    expect(readFileSync(appPkg, "utf-8")).toBe(before);
    expect(existsSync(join(root, "node_modules"))).toBe(false);
  });
});

describe("npm failure reporting", () => {
  async function failureMessage(stderr) {
    fakeNpm({ status: 1, stderr });
    const { loadRuntimeDep } = await import("../../open-sse/services/lazyRuntime.js");
    try {
      await loadRuntimeDep(MISSING_PKG);
      throw new Error("expected the install to fail");
    } catch (error) {
      return error.message;
    }
  }

  it("surfaces the npm error code instead of the debug-log pointer", async () => {
    // Verbatim npm 11+ output; the last line is the useless pointer.
    const message = await failureMessage(
      [
        "npm error code EACCES",
        "npm error syscall mkdir",
        "npm error path /app/node_modules",
        "npm error errno -13",
        "npm error Error: EACCES: permission denied, mkdir '/app/node_modules'",
        "npm error A complete log of this run can be found in: /home/node/.npm/_logs/x-debug-0.log",
      ].join("\n")
    );
    expect(message).toContain("EACCES");
    expect(message).not.toContain("A complete log of this run");
    expect(message).toContain(`npm install ${MISSING_PKG}@latest`);
  });

  it("still understands the legacy npm ERR! prefix", async () => {
    const message = await failureMessage(
      ["npm ERR! code ETARGET", "npm ERR! notarget No matching version found"].join("\n")
    );
    expect(message).toContain("ETARGET");
  });

  it("falls back to a network diagnosis when npm reports no code", async () => {
    const message = await failureMessage(
      "npm error network request to https://registry.npmjs.org/wreq-js failed"
    );
    expect(message).toMatch(/network|registry/i);
  });
});
