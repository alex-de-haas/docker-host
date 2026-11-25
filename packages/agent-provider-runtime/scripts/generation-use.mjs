import { DatabaseSync } from "node:sqlite";
import { existsSync, lstatSync } from "node:fs";
import { readdir, rm, stat, readFile } from "node:fs/promises";
import path from "node:path";

const marker = ".generation-use.sqlite";
const held = new Set();

export function initializeGeneration(directory) {
  const db = new DatabaseSync(path.join(directory, marker));
  try { db.exec("CREATE TABLE IF NOT EXISTS generation(id INTEGER PRIMARY KEY); INSERT OR IGNORE INTO generation VALUES(1)"); }
  finally { db.close(); }
}

export function useGeneration(directory) {
  const db = new DatabaseSync(path.join(directory, marker), { readOnly: true });
  try { db.exec("BEGIN; SELECT id FROM generation WHERE id=1"); }
  catch (error) { db.close(); throw error; }
  held.add(db);
  return () => { if (held.delete(db)) db.close(); };
}

// Build subprocesses can outlive the preparing launcher. Each Node process acquires its own reader.
if (process.env.HOSTY_BUILD_GENERATION) useGeneration(process.env.HOSTY_BUILD_GENERATION);

export function generationBuildEnvironment(directory) {
  if (!existsSync(path.join(directory, marker))) return {};
  return { NODE_OPTIONS: "--import=" + import.meta.url, HOSTY_BUILD_GENERATION: directory };
}

export function unusedGeneration(directory) {
  const file = path.join(directory, marker);
  let db;
  try {
    if (!lstatSync(file).isFile()) return false;
    db = new DatabaseSync(file);
    db.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; SELECT id FROM generation WHERE id=1");
    return true;
  } catch { return false; } finally { db?.close(); }
}

/** Called under the preparation lock. New runtime readers acquire the same lock before selecting a bundle. */
export async function reclaimGenerations(store, current) {
  const entries = await readdir(store, { withFileTypes: true });
  const complete = [], partial = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(store, entry.name);
    if (dir === current || !existsSync(path.join(dir, marker))) continue;
    if (/^(?:g-[a-f0-9-]{36}|[a-f0-9]{64}(?:-[a-f0-9-]{36})?)$/.test(entry.name)) {
      complete.push({ dir, time: (await stat(dir)).mtimeMs });
    } else if (/^(?:\.build-|[a-f0-9]{64}\.incomplete-)[a-f0-9-]{36}$/.test(entry.name)) partial.push(dir);
  }
  complete.sort((a,b) => b.time - a.time || a.dir.localeCompare(b.dir));
  const removed = new Set();
  for (const dir of [...partial, ...complete.slice(2).map(item => item.dir)]) {
    if (!unusedGeneration(dir)) continue;
    try { await rm(dir, { recursive: true, force: true }); removed.add(path.basename(dir)); }
    catch (error) { if (!["EBUSY","EPERM","ENOTEMPTY"].includes(error.code)) throw error; }
  }
  if (!removed.size) return;
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
    const file = path.join(store, entry.name);
    let pointer;
    try { pointer = JSON.parse(await readFile(file, "utf8")); } catch { continue; }
    if (entry.name === pointer.key + ".json" && removed.has(pointer.directory)) await rm(file, { force: true });
  }
}
