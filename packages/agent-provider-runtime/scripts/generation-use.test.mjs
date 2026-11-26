import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initializeGeneration, useGeneration, reclaimGenerations } from "./generation-use.mjs";

test("pruning preserves live and selected generations and removes only owned inactive builds", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hosty-generation-test-"));
  const create = async (name, time, owned = true) => {
    const dir = path.join(root, name);
    await mkdir(dir);
    if (owned) initializeGeneration(dir);
    await utimes(dir, time, time);
    return dir;
  };
  let release;
  try {
    const old = await create("1".repeat(64), 1);
    const held = await create("2".repeat(64), 2);
    release = useGeneration(held);
    await create("3".repeat(64), 3);
    await create("4".repeat(64), 4);
    const selected = await create("5".repeat(64), 5);
    const unowned = await create("6".repeat(64), 0, false);
    const partial = await create(".build-00000000-0000-4000-8000-000000000000", 7);
    const key = "7".repeat(64);
    await writeFile(path.join(root, key + ".json"), JSON.stringify({ key, directory: path.basename(old) }));
    await reclaimGenerations(root, selected);
    const entries = await readdir(root);
    for (const dir of [held, selected, unowned]) assert.ok(entries.includes(path.basename(dir)));
    for (const name of [path.basename(old), path.basename(partial), key + ".json"]) assert.ok(!entries.includes(name));
    release();
    await reclaimGenerations(root, selected);
    assert.ok(!(await readdir(root)).includes(path.basename(held)));
  } finally { release?.(); await rm(root, { recursive: true, force: true }); }
});
