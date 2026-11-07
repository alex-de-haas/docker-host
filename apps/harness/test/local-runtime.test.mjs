import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepare, fingerprint, completeBundle, buildEnvironment } from "../scripts/local-runtime.mjs";

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-local-")); roots.push(root);
  await writeFile(path.join(root, "input"), "first");
  let builds = 0;
  const options = { root, files: ["input"], store: path.join(root, "bundles"), log: () => {},
    buildBundle: async dir => {
      builds++;
      await mkdir(path.join(dir, "web/assistant"), { recursive: true });
      for (const file of ["api.mjs", "worker.mjs", "web/index.html", "web/assistant/index.html"])
        await writeFile(path.join(dir, file), "built " + await readFile(path.join(dir, "input"), "utf8"));
    } };
  return { root, options, builds: () => builds };
}
it("reuses complete output without installing or building and preserves source files", async () => {
  const f = await fixture();
  const first = await prepare(f.options);
  expect(await prepare({ ...f.options, buildBundle: () => { throw new Error("must not build"); } })).toBe(first);
  expect(f.builds()).toBe(1);
  expect(await readFile(path.join(f.root, "input"), "utf8")).toBe("first");
});
it("invalidates changed bytes, Node versions and platforms while preserving the previous bundle", async () => {
  const f = await fixture(), first = await prepare(f.options);
  await writeFile(path.join(f.root, "input"), "other");
  const second = await prepare(f.options);
  expect(second).not.toBe(first);
  const third = await prepare({ ...f.options, identity: { node: "different", platform: "other", arch: "other" } });
  expect(third).not.toBe(second);
  expect(await readFile(path.join(first, "api.mjs"), "utf8")).toBe("built first");
});
it("rebuilds missing static chunks or runtime output instead of accepting a stale marker", async () => {
  const f = await fixture(), first = await prepare(f.options);
  await rm(path.join(first, "web/assistant/index.html"));
  await prepare(f.options);
  expect(f.builds()).toBe(2);
  await writeFile(path.join(first, "worker.mjs"), "truncated");
  await prepare(f.options);
  expect(f.builds()).toBe(3);
});
it("does not publish a failed build and allows a clean retry", async () => {
  const f = await fixture();
  await expect(prepare({ ...f.options, buildBundle: () => { throw new Error("build failed"); } })).rejects.toThrow("build failed");
  expect(await readdir(f.options.store)).toEqual([]);
  await prepare(f.options);
  expect(f.builds()).toBe(1);
});
it("serializes concurrent preparations so only one build occurs", async () => {
  const f = await fixture();
  const results = await Promise.all([prepare(f.options), prepare(f.options)]);
  expect(results[0]).toBe(results[1]);
  expect(f.builds()).toBe(1);
});
it("refuses source changes during preparation", async () => {
  const f = await fixture();
  await expect(prepare({ ...f.options, buildBundle: async dir => {
    await f.options.buildBundle(dir);
    await writeFile(path.join(f.root, "input"), "changed during build");
  } })).rejects.toThrow("source changed");
  expect(await completeBundle(path.join(f.options.store, await fingerprint(f.root, ["input"])), "missing")).toBe(false);
});
it("does not pass app identity, settings or loader overrides into build processes", () => {
  const before = { ...process.env };
  try {
    process.env.HOSTY_APP_SERVICE_TOKEN = "secret";
    process.env.NODE_OPTIONS = "--import=unwanted";
    process.env.HOSTY_HARNESS_WEB_OUTPUT = "/other";
    const env = buildEnvironment();
    expect(env.HOSTY_APP_SERVICE_TOKEN).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.HOSTY_HARNESS_WEB_OUTPUT).toBeUndefined();
    expect(env.NODE_ENV).toBe("production");
  } finally { process.env = before; }
});

it.each([false, true])("recovers an interrupted preparer, including interrupted cleanup (%s)", async interruptedCleanup => {
  const f = await fixture();
  const { spawnSync } = await import("node:child_process");
  const exited = spawnSync(process.execPath, ["-e", ""]);
  expect(exited.status).toBe(0);
  const lock = path.join(f.options.store, "prepare.lock");
  await mkdir(lock, { recursive: true });
  if (!interruptedCleanup)
    await writeFile(path.join(lock, "owner-00000000-0000-0000-0000-000000000001.json"), JSON.stringify({ pid: exited.pid }));
  await Promise.all(Array.from({ length: 8 }, () => prepare(f.options)));
  expect(f.builds()).toBe(1);
});
it("rebuilds after npm workspace or executable links disappear", async () => {
  const f = await fixture();
  const { symlink } = await import("node:fs/promises");
  const options = { ...f.options, buildBundle: async dir => {
    await f.options.buildBundle(dir);
    await symlink("worker.mjs", path.join(dir, "worker-link"));
  } };
  const bundle = await prepare(options);
  await rm(path.join(bundle, "worker-link"));
  await prepare(options);
  expect(f.builds()).toBe(2);
});

it("keeps dynamic app dependencies and only externally imported SDK dependencies in the standalone runtime", async () => {
  const { runtimePackage } = await import("../scripts/local-runtime.mjs");
  const { build } = await import("esbuild");
  const compiled = await build({ stdin: { contents: 'import { hash } from "@sdk/hashes/sha2.js"; console.log(hash); import("sdk-server/stream"); import("@scope/prefix-lookalike/unrelated");', resolveDir: process.cwd() },
    bundle: true, platform: "node", format: "esm", packages: "external", metafile: true, write: false });
  const imports = Object.values(compiled.metafile.outputs).flatMap(output => output.imports.filter(value => value.external).map(value => value.path));
  const dependency = { version: "1.2.3", integrity: "locked" };
  const source = { lockfileVersion: 3, packages: {
    "": { workspaces: ["apps/*"] }, "apps/harness": { version: "0.1.0" },
    "node_modules/native-provider": dependency,
    "node_modules/native-provider/node_modules/nested": { version: "3.2.1" },
    "node_modules/@hosty-sdk/app": { link: true, resolved: "packages/app-sdk" },
  } };
  const { manifest, lock } = runtimePackage({ version: "0.1.0", dependencies: {
    "native-provider": "1.2.3", "@hosty-sdk/app": "*", tsx: "^4",
  } }, { dependencies: { "@sdk/hashes": "2", "sdk-server": "3", "ui-icons": "4", "@scope/prefix": "5" }, peerDependencies: { next: "^16", react: "^19" } }, {}, source, imports);
  expect(manifest.dependencies).toEqual({ "native-provider": "1.2.3", "@sdk/hashes": "2", "sdk-server": "3" });
  expect(manifest.dependencies["ui-icons"]).toBeUndefined();
  expect(manifest.dependencies["@scope/prefix"]).toBeUndefined();
  expect(manifest.dependencies.react).toBeUndefined();
  expect(manifest.workspaces).toBeUndefined();
  expect(lock.packages["node_modules/native-provider"]).toBe(dependency);
  expect(lock.packages["node_modules/native-provider/node_modules/nested"].version).toBe("3.2.1");
  expect(lock.packages["node_modules/@hosty-sdk/app"]).toBeUndefined();
  expect(source.packages[""].workspaces).toEqual(["apps/*"]);
});

it("defaults to no SDK dependencies when the backend has no external SDK imports", async () => {
  const { runtimePackage } = await import("../scripts/local-runtime.mjs");
  const { manifest } = runtimePackage({ version: "1", dependencies: { "native-provider": "1" } },
    { dependencies: { "ui-icons": "2" } }, {}, { packages: {} });
  expect(manifest.dependencies).toEqual({ "native-provider": "1" });
});

it("rejects an unbounded or malformed SDK import inventory", async () => {
  const { runtimePackage } = await import("../scripts/local-runtime.mjs");
  for (const imports of [null, {}, "sdk", Array(257).fill("sdk"), [null], ["x".repeat(2049)]])
    expect(() => runtimePackage({ version: "1", dependencies: {} }, {}, {}, { packages: {} }, imports))
      .toThrow("Invalid compiled SDK runtime import inventory");
});
