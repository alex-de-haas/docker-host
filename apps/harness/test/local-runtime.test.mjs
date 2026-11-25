import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, cp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepare, fingerprint, completeBundle, buildEnvironment, sourceFiles, repository, run, stageRuntime } from "../scripts/local-runtime.mjs";

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
      for (const file of ["api.mjs", "web/index.html", "web/assistant/index.html"])
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
it("keeps an active damaged generation at its original path while publishing the repaired bundle", async () => {
  const f = await fixture();
  const first = await prepare(f.options);
  const { useGeneration } = await import("../../../packages/agent-provider-runtime/scripts/generation-use.mjs");
  const release = useGeneration(first);
  try {
    await writeFile(path.join(first, "api.mjs"), "old generation");
    const replacement = await prepare(f.options);
    expect(replacement).not.toBe(first);
    expect(await prepare(f.options)).toBe(replacement);
    expect(await readFile(path.join(first, "api.mjs"), "utf8")).toBe("old generation");
  } finally { release(); }
});
it("snapshots public favicons and invalidates cached bundles when public assets change", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-public-")); roots.push(root);
  // Derive config inputs from production discovery, leaving recursive source trees empty so
  // each preparation copies only the files relevant to this test.
  const sourceDirectories = ["apps/harness/src", "apps/harness/shared", "apps/harness/web/src",
    "apps/harness/web/public", "packages/app-sdk/src", "shared/web"];
  for (const directory of sourceDirectories)
    await mkdir(path.join(root, directory), { recursive: true });
  for (const file of (await sourceFiles(repository)).filter(file =>
    !sourceDirectories.some(directory => file.startsWith(directory + "/")))) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), "fixture source");
  }
  const publicDirectory = "apps/harness/web/public";
  const icons = ["favicon.svg", "favicon-light.svg", "favicon-dark.svg", "favicon.ico"];
  await mkdir(path.join(root, publicDirectory), { recursive: true });
  for (const icon of icons)
    await writeFile(path.join(root, publicDirectory, icon), await readFile(path.join(repository, publicDirectory, icon)));
  expect(await sourceFiles(root)).toEqual(expect.arrayContaining(icons.map(icon => publicDirectory + "/" + icon)));
  let builds = 0;
  const options = { root, store: path.join(root, "bundles"), log: () => {}, buildBundle: async dir => {
    builds++;
    await mkdir(path.join(dir, "web/assistant"), { recursive: true });
    for (const file of ["api.mjs", "web/index.html", "web/assistant/index.html"])
      await writeFile(path.join(dir, file), "built");
    await cp(path.join(dir, publicDirectory), path.join(dir, "web"), { recursive: true });
  } };
  const first = await prepare(options);
  for (const icon of icons)
    expect(await readFile(path.join(first, "web", icon))).toEqual(await readFile(path.join(root, publicDirectory, icon)));
  expect(await prepare(options)).toBe(first);
  expect(builds).toBe(1);

  const original = await readFile(path.join(first, "web/favicon.svg"));
  const changed = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="16" height="16"/></svg>');
  await writeFile(path.join(root, publicDirectory, "favicon.svg"), changed);
  const second = await prepare(options);
  expect(second).not.toBe(first);
  expect(await readFile(path.join(second, "web/favicon.svg"))).toEqual(changed);
  expect(await readFile(path.join(first, "web/favicon.svg"))).toEqual(original);

  await writeFile(path.join(root, publicDirectory, "robots.txt"), "User-agent: *");
  const third = await prepare(options);
  expect(third).not.toBe(second);
  expect(await readFile(path.join(third, "web/robots.txt"), "utf8")).toBe("User-agent: *");
  await rm(path.join(root, publicDirectory, "robots.txt"));
  expect(await prepare(options)).toBe(second);
  expect(builds).toBe(3);
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
  await writeFile(path.join(first, "api.mjs"), "truncated");
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

it("passes an explicit bounded-build flag without inheriting runtime credentials or loader overrides", async () => {
  const f = await fixture(), result = path.join(f.root, "build-environment.json"), before = { ...process.env };
  try {
    process.env.HOSTY_APP_SERVICE_TOKEN = "synthetic-runtime-secret";
    process.env.NODE_OPTIONS = "--import=must-not-load";
    process.env.HOSTY_HARNESS_BOUNDED_BUILD = "untrusted-parent-value";
    await run(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({bounded:process.env.HOSTY_HARNESS_BOUNDED_BUILD, identity:process.env.HOSTY_APP_SERVICE_TOKEN, loader:process.env.NODE_OPTIONS}))", result],
      f.root, { boundedBuild: true });
    expect(JSON.parse(await readFile(result, "utf8"))).toEqual({ bounded: "1" });
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
    await symlink("api.mjs", path.join(dir, "api-link"));
  } };
  const bundle = await prepare(options);
  await rm(path.join(bundle, "api-link"));
  await prepare(options);
  expect(f.builds()).toBe(2);
});

it("keeps dynamic app dependencies and only externally imported SDK dependencies in the standalone runtime", async () => {
  const { runtimePackage } = await import("../scripts/local-runtime.mjs");
  const { build } = await import("esbuild");
  const compiled = await build({ stdin: { contents: 'import { hash } from "@sdk/hashes/sha2.js"; console.log(hash); import("sdk-server/stream"); import("@scope/prefix-lookalike/unrelated");', resolveDir: process.cwd() },
    bundle: true, platform: "node", format: "esm", packages: "external", metafile: true, write: false });
  const imports = Object.values(compiled.metafile.outputs).flatMap(output => output.imports.filter(value => value.external).map(value => value.path));
  const dependency = { version: "1.2.3", integrity: "locked", resolved: "https://registry.example/native-provider.tgz", dependencies: { nested: "3.2.1" } };
  const source = { lockfileVersion: 3, packages: {
    "": { workspaces: ["apps/*"] }, "apps/harness": { version: "0.1.0" },
    "node_modules/native-provider": dependency,
    "node_modules/native-provider/node_modules/nested": { version: "3.2.1", integrity: "nested-lock", resolved: "https://registry.example/nested.tgz" },
    "node_modules/@sdk/hashes": { version: "2.0.0", integrity: "hash-lock", resolved: "https://registry.example/hashes.tgz", dev: true },
    "node_modules/sdk-server": { version: "3.0.0", integrity: "server-lock", resolved: "https://registry.example/server.tgz" },
    "node_modules/ui-icons": { version: "4.0.0", integrity: "unused-lock", resolved: "https://registry.example/icons.tgz" },
    "node_modules/tsx": { version: "4.0.0", integrity: "unused-lock", resolved: "https://registry.example/tsx.tgz" },
    "node_modules/next": { version: "16.0.0", integrity: "unused-lock", resolved: "https://registry.example/next.tgz" },
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
  expect(lock.packages["node_modules/native-provider"]).toEqual(dependency);
  expect(lock.packages["node_modules/native-provider/node_modules/nested"].version).toBe("3.2.1");
  expect(lock.packages["node_modules/@hosty-sdk/app"]).toBeUndefined();
  expect(lock.packages["node_modules/@sdk/hashes"].dev).toBeUndefined();
  expect(source.packages["node_modules/@sdk/hashes"].dev).toBe(true);
  expect(lock.packages["node_modules/ui-icons"]).toBeUndefined();
  expect(lock.packages["node_modules/next"]).toBeUndefined();
  expect(lock.packages["node_modules/tsx"]).toBeUndefined();
  expect(source.packages[""].workspaces).toEqual(["apps/*"]);
});

it("defaults to no SDK dependencies when the backend has no external SDK imports", async () => {
  const { runtimePackage } = await import("../scripts/local-runtime.mjs");
  const { manifest } = runtimePackage({ version: "1", dependencies: { "native-provider": "1" } },
    { dependencies: { "ui-icons": "2" } }, {}, { lockfileVersion: 3, packages: { "": {}, "node_modules/native-provider": { version: "1.0.0", integrity: "locked", resolved: "https://registry.example/provider.tgz" } } });
  expect(manifest.dependencies).toEqual({ "native-provider": "1" });
});

it("rejects an unbounded or malformed SDK import inventory", async () => {
  const { runtimePackage } = await import("../scripts/local-runtime.mjs");
  for (const imports of [null, {}, "sdk", Array(257).fill("sdk"), [null], ["x".repeat(2049)]])
    expect(() => runtimePackage({ version: "1", dependencies: {} }, {}, {}, { packages: {} }, imports))
      .toThrow("Invalid compiled SDK runtime import inventory");
});


it("stages only compiled launch assets and exact production dependencies for either supported build path", async () => {
  const { runtimePackage } = await import("../scripts/local-runtime.mjs");
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-stage-")); roots.push(root);
  const output = path.join(root, "runtime"), app = { name: "source-app", version: "0.99.0", license: "AGPL-3.0-only", dependencies: { worker: "1.0.0", "@hosty-sdk/app": "*" }, devDependencies: { tsx: "4.0.0" } };
  const sdk = { dependencies: { hashes: "2.0.0", "unused-ui": "1.0.0" } };
  const locked = (version, name) => ({ version, integrity: name, resolved: "https://registry.example/" + name + ".tgz" });
  const lock = { lockfileVersion: 3, packages: { "": {}, "node_modules/worker": locked("1.0.0", "worker"),
    "node_modules/hashes": locked("2.0.0", "hashes"), "node_modules/unused-ui": locked("1.0.0", "ui"),
    "node_modules/tsx": locked("4.0.0", "tsx") } };
  for (const directory of ["apps/harness/web/out-build/assistant", "apps/harness/src", "packages/app-sdk"]) await mkdir(path.join(root, directory), { recursive: true });
  for (const [file, value] of Object.entries({ "apps/harness/package.json": app, "packages/app-sdk/package.json": sdk, "package.json": { private: true }, "package-lock.json": lock, "runtime-sdk-imports.json": ["hashes/subpath"] }))
    await writeFile(path.join(root, file), JSON.stringify(value));
  await writeFile(path.join(root, "api.mjs"), "console.log('compiled API');");
  await writeFile(path.join(root, "apps/harness/src/main.ts"), "Source stays outside the runtime payload");
  await writeFile(path.join(root, "apps/harness/web/out-build/index.html"), "<main>Settings</main>");
  await writeFile(path.join(root, "apps/harness/web/out-build/assistant/index.html"), "<main>Assistant</main>");
  await stageRuntime(root, output);
  expect((await readdir(output)).sort()).toEqual(["api.mjs", "package-lock.json", "package.json", "web"]);
  expect(await readFile(path.join(output, "api.mjs"), "utf8")).toBe("console.log('compiled API');");
  expect(await readFile(path.join(output, "web/assistant/index.html"), "utf8")).toContain("Assistant");
  const manifest = JSON.parse(await readFile(path.join(output, "package.json"), "utf8"));
  expect(manifest.scripts).toEqual({ start: "node api.mjs" }); expect(manifest.dependencies).toEqual({ worker: "1.0.0", hashes: "2.0.0" });
  expect(JSON.parse(await readFile(path.join(output, "package-lock.json"), "utf8"))).toEqual(runtimePackage(app, sdk, {}, lock, ["hashes/subpath"]).lock);
  expect(JSON.parse(await readFile(path.join(root, "apps/harness/package.json"), "utf8"))).toEqual(app);
});

it("declares only Docker production while retaining both managed source-development profiles", async () => {
  const manifest = JSON.parse(await readFile(path.join(repository, "apps/harness/manifest.json"), "utf8"));
  expect(manifest.runtimeProfiles.filter(profile => !profile.development).map(profile => profile.key)).toEqual(["docker"]);
  expect(manifest.defaultRuntime).toBe("docker");
  expect(manifest.runtimeProfiles.filter(profile => profile.development).map(profile => profile.key).sort()).toEqual(["dev", "docker-dev"]);
  const runtimes = manifest.services.find(service => service.key === "api").runtimes;
  expect(runtimes.dev).toMatchObject({ type: "localCommand", setup: "node scripts/local-runtime.mjs prepare", command: "node scripts/local-runtime.mjs start api" });
  expect(runtimes["docker-dev"]).toMatchObject({ type: "docker", artifact: "source", sourceMount: { mode: "ro", caches: ["apps/harness/.local-runtime"] } });
  for (const section of [manifest.data, manifest.cache]) expect(section.targets.map(target => target.runtime).sort()).toEqual(["dev", "docker", "docker-dev"]);
});
