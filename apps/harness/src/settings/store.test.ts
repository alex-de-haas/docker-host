import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
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


it("keeps retired translation selections inert and preserves their values during unrelated saves", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "hosty-settings-retired-"));
  const retired = { translationConnections: { codex: { connectionId: "retained-account", connectionRevision: "1", harnessKind: "agent" }, claude: null },
    translationModels: { codex: "retained-model", claude: null } };
  try {
    writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify({ ...retired, systemPrompt: "Existing instructions" }));
    const store = new SettingsStore(dataDir);
    const active = await store.read();
    expect(active).toMatchObject({ systemPrompt: "Existing instructions" });
    expect(active).not.toHaveProperty("translationConnections");
    expect(active).not.toHaveProperty("translationModels");
    await store.update({ systemPrompt: "Updated instructions" });
    const persisted = JSON.parse(readFileSync(path.join(dataDir, "settings.json"), "utf8"));
    expect(persisted).toMatchObject({ ...retired, systemPrompt: "Updated instructions" });
    const reopened = await new SettingsStore(dataDir).read();
    expect(reopened).not.toHaveProperty("translationConnections");
    expect(reopened).not.toHaveProperty("translationModels");
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
