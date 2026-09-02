import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SettingsStore } from "./store.js";

describe("SettingsStore.mergeSkillDigests", () => {
  it("loses no write when several land at once", async () => {
    // update is a read-modify-write. Unserialized, two callers read the same snapshot and one patch
    // disappears — and for skill digests the loss is invisible: a digest silently absent later reads
    // as "this app changed" and withholds a skill nobody touched. Concurrent writes also shared one
    // temp path, so the loser's rename failed with ENOENT for a reason no caller could explain.
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "hosty-settings-race-"));
    try {
      const store = new SettingsStore(dataDir);

      await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          store.mergeSkillDigests({ [`app-${index}`]: `digest-${index}` }),
        ),
      );

      const settings = await store.read();
      // Each update merges onto the one before it, so the final file holds every key rather than
      // whichever write happened to land last.
      expect(Object.keys(settings.mcpSkillDigests)).toHaveLength(12);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("SettingsStore Core defaults", () => {
  it("offers Core on, with read-only tools unprompted, until the operator says otherwise", async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "hosty-settings-core-"));
    try {
      const store = new SettingsStore(dataDir);
      // Nothing on disk yet: the row exists anyway, because absent means on for Core alone.
      const fresh = await store.read();
      expect(fresh.mcpProviders).toEqual({ "hosty:core": true });
      expect(fresh.mcpAutoAllow).toEqual({ "hosty:core": true });

      // An explicit off is stored, survives a re-read from disk, and survives pruning — Core is never
      // in the installed roster, and dropping the key would have the default put it back on.
      await store.update({ mcpProviders: { "hosty:core": false } });
      const reread = await new SettingsStore(dataDir).read();
      expect(reread.mcpProviders).toEqual({ "hosty:core": false });
      const pruned = await store.prune([]);
      expect(pruned.mcpProviders).toEqual({ "hosty:core": false });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
