import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";

const prepared = "/opt/hosty/prepared";
const names = ["package-lock.json", "package.json", "apps/demo-app/package.json", "packages/app-sdk/package.json"];
async function fingerprint(root) {
  const hash = createHash("sha256");
  for (const name of names) hash.update(name).update("\0").update(await readFile(path.join(root, name)));
  return hash.digest("hex");
}
if (process.argv[2] === "--record") {
  await writeFile("/opt/hosty/dependencies.sha256", await fingerprint(process.argv[3]));
} else {
  const root = process.argv[2];
  const expected = (await readFile("/opt/hosty/dependencies.sha256", "utf8")).trim();
  if (await fingerprint(root) !== expected) throw new Error("dependencies_not_prepared: rebuild the reviewed dependency image before running this lockfile");
  // Ordinary Core gives each service a private cache. A fresh preparation ID avoids
  // retaining a stale lock after an interrupted container start.
  const generation = randomUUID().replaceAll("-", "");
  if (!/^[a-f0-9]{32}$/.test(generation ?? "")) throw new Error("Invalid preparation ID");
  for (const relative of ["node_modules", "apps/demo-app/node_modules"]) {
    const target = path.join(root, relative);
    const marker = path.join(target, ".hosty-ready-" + expected);
    const lock = path.join(target, ".hosty-prepare-" + generation);
    if (await stat(marker).catch(() => null)) continue;
    let acquired = false;
    try { await mkdir(lock); acquired = true; } catch (error) { if (error.code !== "EEXIST") throw error; }
    if (acquired) {
      const source = path.join(prepared, relative);
      if (await stat(source).catch(() => null)) await cp(source, target, { recursive: true, force: true, verbatimSymlinks: true });
      await writeFile(marker, expected, { flag: "wx" });
    } else {
      const deadline = Date.now() + 9 * 60_000;
      while (!await stat(marker).catch(() => null)) {
        if (Date.now() >= deadline) throw new Error("Dependency preparation did not complete");
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }
}
