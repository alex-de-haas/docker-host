import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, readdir, lstat, stat, copyFile, rename, rm, open, readlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const inputs = [
  "package.json", "package-lock.json", "apps/harness/manifest.json", "apps/harness/package.json",
  "apps/harness/tsconfig.json", "apps/harness/scripts/local-runtime.mjs",
  "apps/harness/scripts/build-local.mjs", "apps/harness/src",
  "apps/harness/web/package.json", "apps/harness/web/next.config.ts", "apps/harness/web/tsconfig.json",
  "apps/harness/web/postcss.config.mjs", "apps/harness/web/src",
  "packages/app-sdk/package.json", "packages/app-sdk/src", "shared/web",
];
const excluded = /(?:^|\/)(?:[^/]+\.(?:test|spec)\.[^/]+|__tests__)(?:\/|$)/;
export const platformIdentity = () => ({ node: process.version, platform: process.platform, arch: process.arch });

export async function sourceFiles(root) {
  const files = [];
  async function visit(relative) {
    if (excluded.test(relative)) return;
    const info = await lstat(path.join(root, relative));
    if (info.isSymbolicLink()) throw new Error("Production build input must not be a symlink: " + relative);
    if (info.isDirectory()) {
      for (const name of (await readdir(path.join(root, relative))).sort()) await visit(relative + "/" + name);
    } else if (info.isFile()) files.push(relative);
  }
  for (const entry of inputs) await visit(entry);
  return files.sort();
}

export async function fingerprint(root, files, identity = platformIdentity()) {
  const hash = createHash("sha256").update(JSON.stringify(identity));
  for (const file of files) hash.update("\0" + file + "\0").update(await readFile(path.join(root, file)));
  return hash.digest("hex");
}

async function inventory(root, relative = "") {
  const files = [];
  for (const name of (await readdir(path.join(root, relative))).sort()) {
    const item = path.join(relative, name).split(path.sep).join("/");
    const info = await lstat(path.join(root, item));
    if (info.isSymbolicLink()) { files.push([item, info.size, await readlink(path.join(root, item))]); continue; }
    if (info.isDirectory()) files.push(...await inventory(root, item));
    else if (info.isFile()) files.push([item, info.size]);
  }
  return files;
}

export async function completeBundle(directory, key) {
  try {
    const receipt = JSON.parse(await readFile(path.join(directory, "bundle.json"), "utf8"));
    if (receipt.key !== key || !Array.isArray(receipt.files) || !receipt.files.length) return false;
    for (const [file, size, link] of receipt.files) {
      const resolved = path.resolve(directory, file);
      if (!resolved.startsWith(directory + path.sep)) return false;
      const info = await lstat(resolved);
      if (link !== undefined) {
        if (!info.isSymbolicLink() || await readlink(resolved) !== link) return false;
        await stat(resolved);
      } else if (!info.isFile() || info.size !== size) return false;
    }
    return ["api.mjs", "worker.mjs", "web/index.html", "web/assistant/index.html"]
      .every(file => receipt.files.some(([entry]) => entry === file));
  } catch { return false; }
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function lock(store) {
  const directory = path.join(store, "prepare.lock");
  const candidate = path.join(store, ".lock-" + randomUUID());
  await mkdir(candidate);
  await writeFile(path.join(candidate, "owner.json"), JSON.stringify({ pid: process.pid }));
  const deadline = Date.now() + 300_000;
  try {
    while (true) {
      try {
        // Publish the owner with the lock; an interrupted acquisition never leaves an empty lock.
        await rename(candidate, directory);
        return async () => { await rm(directory, { recursive: true, force: true }); };
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(error.code)) throw error;
        let claim;
        try {
          // Only one contender may recover this abandoned lock. Re-read the owner after claiming:
          // another preparer may already have replaced the old directory with its live lock.
          claim = await open(path.join(directory, "recover"), "wx");
          const owner = JSON.parse(await readFile(path.join(directory, "owner.json"), "utf8"));
          if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error("Invalid preparation lock owner.");
          try { process.kill(owner.pid, 0); }
          catch (probe) {
            if (probe.code === "ESRCH") {
              const abandoned = directory + ".abandoned-" + randomUUID();
              await rename(directory, abandoned);
              await claim.close(); claim = null;
              await rm(abandoned, { recursive: true, force: true });
              continue;
            }
            if (probe.code !== "EPERM") throw probe;
          }
        } catch (probe) {
          if (!["EEXIST", "ENOENT"].includes(probe.code)) throw probe;
        } finally {
          if (claim) {
            await claim.close();
            await rm(path.join(directory, "recover"), { force: true });
          }
        }
        if (Date.now() >= deadline) throw new Error("Timed out waiting for Harness production preparation.");
        await wait(100);
      }
    }
  } finally { await rm(candidate, { recursive: true, force: true }); }
}

export function buildEnvironment() {
  const env = {};
  for (const key of ["PATH", "HOME", "USERPROFILE", "SystemRoot", "COMSPEC", "PATHEXT",
    "TEMP", "TMP", "TMPDIR", "LANG", "LOCALAPPDATA", "APPDATA", "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return { ...env, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" };
}

export async function run(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: buildEnvironment(), stdio: "inherit",
      shell: process.platform === "win32" && command === "npm" });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() :
      reject(new Error(command + " failed (" + (signal || code) + ").")));
  });
}


export function runtimePackage(app, sdk, rootPackage, sourceLock) {
  // The SDK is compiled into the entry points. Its third-party dependencies still need runtime
  // delivery, but its optional React/Next peers and the development TS loader do not.
  const dependencies = { ...sdk.dependencies, ...app.dependencies };
  delete dependencies["@hosty-sdk/app"];
  delete dependencies.tsx;
  const manifest = { name: "hosty-harness-local", version: app.version, private: true,
    type: "module", license: app.license, dependencies, overrides: rootPackage.overrides };
  // Keep the exact resolved versions/integrities and nested dependency paths from the reviewed
  // lock. npm ci validates this standalone root and installs only its reachable runtime graph.
  const lock = { ...sourceLock, name: manifest.name, version: manifest.version,
    packages: { "": { name: manifest.name, version: manifest.version, dependencies },
      ...Object.fromEntries(Object.entries(sourceLock.packages)
        .filter(([name, entry]) => name.startsWith("node_modules/") && !entry.link)) } };
  return { manifest, lock };
}
export async function build(snapshot) {
  await run("npm", ["ci", "--include=dev", "--no-audit", "--no-fund",
    "--workspace", "@haas/hosty-harness", "--workspace", "@haas/hosty-harness-web",
    "--workspace", "@hosty-sdk/app"], snapshot);
  await run(process.execPath, ["apps/harness/scripts/build-local.mjs"], snapshot);
  // Reinstall only runtime dependencies from the same lock. The build snapshot is disposable;
  // neither the original checkout's node_modules nor a previous generation is mutated.
  const json = async file => JSON.parse(await readFile(path.join(snapshot, file), "utf8"));
  const runtime = runtimePackage(await json("apps/harness/package.json"), await json("packages/app-sdk/package.json"),
    await json("package.json"), await json("package-lock.json"));
  await writeFile(path.join(snapshot, "package.json"), JSON.stringify(runtime.manifest, null, 2) + "\n");
  await writeFile(path.join(snapshot, "package-lock.json"), JSON.stringify(runtime.lock, null, 2) + "\n");
  await run("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], snapshot);
  await rename(path.join(snapshot, "apps/harness/web/out-build"), path.join(snapshot, "web"));
  for (const directory of ["apps", "packages", "shared"])
    await rm(path.join(snapshot, directory), { recursive: true, force: true });
}

export async function prepare({ root = repository, store = path.join(root, "apps/harness/.local-runtime"),
  files, identity = platformIdentity(), buildBundle = build, log = console.log } = {}) {
  const discover = files === undefined;
  files ??= await sourceFiles(root);
  const key = await fingerprint(root, files, identity);
  const generation = path.join(store, key);
  const started = performance.now();
  await mkdir(store, { recursive: true });
  const release = await lock(store);
  try {
    if (await completeBundle(generation, key)) {
      log("[local-runtime] Reusing production bundle " + key.slice(0, 12) + " (" +
        Math.round(performance.now() - started) + " ms); no install or build.");
      return generation;
    }
    const staging = path.join(store, ".build-" + randomUUID());
    await mkdir(staging);
    try {
      log("[local-runtime] Preparing production bundle " + key.slice(0, 12));
      for (const file of files) {
        const target = path.join(staging, file);
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(path.join(root, file), target);
      }
      if (await fingerprint(staging, files, identity) !== key)
        throw new Error("Harness source changed while taking its build snapshot; retry preparation.");
      await buildBundle(staging);
      await writeFile(path.join(staging, "bundle.json"), JSON.stringify({
        key, identity, files: await inventory(staging),
      }));
      if (!await completeBundle(staging, key)) throw new Error("Harness production bundle is incomplete.");
      if (await fingerprint(root, discover ? await sourceFiles(root) : files, identity) !== key)
        throw new Error("Harness source changed during preparation; retry with the current source.");
      // Preserve an incomplete generation for any existing consumers instead of overwriting it.
      try { await rename(generation, generation + ".incomplete-" + randomUUID()); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      await rename(staging, generation);
      log("[local-runtime] Production bundle ready (" + Math.round(performance.now() - started) + " ms).");
      return generation;
    } finally { await rm(staging, { recursive: true, force: true }); }
  } finally { await release(); }
}

export async function start(service, root = repository) {
  if (!["api", "worker"].includes(service)) throw new Error("Expected api or worker.");
  const key = await fingerprint(root, await sourceFiles(root));
  const generation = path.join(root, "apps/harness/.local-runtime", key);
  if (!await completeBundle(generation, key))
    throw new Error("Harness production bundle is absent or incomplete. Run node scripts/local-runtime.mjs prepare first.");
  process.env.NODE_ENV = "production";
  process.env.HOSTY_HARNESS_WEB_OUTPUT = path.join(generation, "web");
  await import(pathToFileURL(path.join(generation, service + ".mjs")).href);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Harness local production requires Node.js 24 or newer.");
    if (process.argv[2] === "prepare") await prepare();
    else if (process.argv[2] === "start") await start(process.argv[3]);
    else throw new Error("Usage: node scripts/local-runtime.mjs prepare | start <api|worker>");
  } catch (error) { console.error("[local-runtime] " + error.message); process.exitCode = 1; }
}
