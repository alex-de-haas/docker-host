import { expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsStore } from "./store.js";
it("captures the legacy retention once so restart environment changes do not overwrite it", async () => {
  const root = mkdtempSync(join(tmpdir(), "hosty-retention-migration-"));
  try {
    const store = new SettingsStore(root, 90); await store.update({});
    expect((await new SettingsStore(root, 30).read()).retention?.ordinaryDays).toBe(90);
    await store.update({ retention: { ordinaryDays: null, completedWorkspaceDays: 7 } });
    expect((await new SettingsStore(root, 30).read()).retention).toEqual({ ordinaryDays: null, completedWorkspaceDays: 7 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
