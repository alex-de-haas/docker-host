import { expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderDirectory } from "./providers.js";
import { SettingsStore } from "./store.js";
it("migrates only matching previously approved instructions for an enabled relationship, once", async () => {
  const root = mkdtempSync(join(tmpdir(), "hosty-instruction-migration-"));
  const target = (id: string, offered: boolean, digest: string, approvedDigest: string) => ({ id, displayName: id, offered, installedAt: "installation-1", runtimeState: "running", interfaces: [], skills: [{ key: "agent", digest, approvedDigest }] });
  let targets = [target("accepted", true, "same", "same"), target("disabled", false, "same", "same"), target("changed", true, "new", "old")];
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ apps: [], agents: { revision: "r1", targets } }));
  try {
    const directory = new ProviderDirectory("http://core", "service", "assistant"); const store = new SettingsStore(root);
    await directory.read(); await directory.migrateInstructions(store);
    expect(directory.localApprovedSkills(await store.read())).toEqual({ accepted: "same" });
    targets = [target("accepted", true, "same", "same"), target("disabled", true, "same", "same")];
    await directory.read(); await directory.migrateInstructions(store);
    expect(directory.localApprovedSkills(await store.read())).toEqual({ accepted: "same" });
    targets = [{ ...target("accepted", true, "same", "same"), installedAt: "installation-2" }];
    await directory.read(); expect(directory.localApprovedSkills(await store.read())).toEqual({});
  } finally { fetcher.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});
it("captures the legacy retention once so restart environment changes do not overwrite it", async () => {
  const root = mkdtempSync(join(tmpdir(), "hosty-retention-migration-"));
  try {
    const store = new SettingsStore(root, 90); await store.update({});
    expect((await new SettingsStore(root, 30).read()).retention?.ordinaryDays).toBe(90);
    await store.update({ retention: { ordinaryDays: null, completedWorkspaceDays: 7 } });
    expect((await new SettingsStore(root, 30).read()).retention).toEqual({ ordinaryDays: null, completedWorkspaceDays: 7 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
