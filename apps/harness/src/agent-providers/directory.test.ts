import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { AgentConnectionDirectory, agentConnectionId, agentSelectionId } from "./directory.js";
import type { AgentConnectionEntry, AgentConnectionSelection, AgentDirectoryBackend, AgentProviderEntry } from "./types.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const authority = async () => "current-authority-supplied-only-to-Core";
async function fixture(retained?: () => Promise<AgentConnectionSelection[]>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hosty-agent-directory-")); roots.push(root);
  const provider: AgentProviderEntry = { ref: { appId: "unrelated.vendor.application", installationId: "first-installation", key: "coding" }, displayName: "Independent agent", available: true };
  let accounts: AgentConnectionEntry[] = [{ id: "account", revision: "1", name: "Work", available: true }];
  let failure = false;
  const backend: AgentDirectoryBackend = { providers: async () => [structuredClone(provider)], connections: async () => {
    if (failure) throw new Error("Access revoked"); return structuredClone(accounts);
  } };
  return { directory: new AgentConnectionDirectory(root, backend, retained), provider, setAccounts: (value: AgentConnectionEntry[]) => { accounts = value; }, deny: () => { failure = true; } };
}
describe("consumer-owned agent selections", () => {
  it("does not choose an account merely because discovery found one", async () => {
    const { directory } = await fixture();
    expect((await directory.list(authority)).connections).toHaveLength(1);
    expect(await directory.binding(undefined, authority)).toBeNull();
  });
  it("preserves static account keys and distinguishes named implementations sharing the same connection", async () => {
    const { directory, provider } = await fixture();
    const connection = { id: "account", revision: "1" };
    const expected = createHash("sha256").update(JSON.stringify([provider.ref.appId, provider.ref.installationId, provider.ref.key, "account", "1"])).digest("hex");
    expect(agentSelectionId({ provider: { ...provider.ref, implementationId: null }, connection })).toBe(expected);
    provider.ref.implementationId = "work";
    const work = (await directory.list(authority)).connections[0]!;
    expect(work.id).not.toBe(expected);
    await directory.setDefault(work.id, authority);
    provider.ref.implementationId = "personal";
    expect((await directory.list(authority)).connections[0]!.id).not.toBe(work.id);
    await expect(directory.binding(undefined, authority)).rejects.toMatchObject({ code: "provider_connection_changed" });
  });
  it("remembers the logical account through a rename, credential revision and provider reinstall", async () => {
    const { directory, provider, setAccounts } = await fixture();
    const account = (await directory.list(authority)).connections[0]!;
    const oldHash = agentSelectionId(account.selection);
    await directory.setDefault(oldHash, authority);
    setAccounts([{ id: "account", revision: "2", name: "Renamed", available: true }]);
    provider.ref.installationId = "replacement-installation";
    const latest = await directory.list(authority);
    expect(latest.defaultId).toBe(account.id);
    expect(latest.connections[0]).toMatchObject({ id: account.id, name: "Renamed", revision: "2" });
    expect(await directory.binding(undefined, authority)).toEqual({ provider: provider.ref, connection: { id: "account", revision: "2" } });
    expect((await directory.get(oldHash, authority)).id).toBe(account.id);
    setAccounts([{ id: "recreated-account", revision: "2", name: "Renamed", available: true }]);
    await expect(directory.binding(undefined, authority)).rejects.toMatchObject({ code: "provider_connection_changed" });
    await expect(directory.get(oldHash, authority)).rejects.toMatchObject({ code: "provider_connection_changed" });
  });

  it("resolves an opaque legacy preference only when retained evidence gives one current match", async () => {
    const retained: AgentConnectionSelection[] = [];
    const { directory, provider, setAccounts } = await fixture(async () => retained);
    const old = { provider: { ...provider.ref, installationId: "previous" }, connection: { id: "account", revision: "4" } };
    const hash = agentSelectionId(old);
    await expect(directory.get(hash, authority)).rejects.toMatchObject({ code: "provider_connection_changed" });
    retained.push(old);
    expect(await directory.migratePreferences([hash], authority)).toEqual(new Map([[hash, agentConnectionId(old)]]));
    expect(await directory.binding(hash, authority)).toEqual({ provider: provider.ref, connection: { id: "account", revision: "1" } });
    setAccounts([{ id: "account", revision: "1", name: "One", available: true }, { id: "account", revision: "2", name: "Two", available: true }]);
    expect(await directory.currentSelection(old, authority)).toBeNull();
    await expect(directory.get(hash, authority)).rejects.toMatchObject({ code: "provider_connection_changed" });
  });
  it("does not reuse previously visible accounts after access is revoked", async () => {
    const { directory, deny } = await fixture();
    expect((await directory.list(authority)).connections).toHaveLength(1);
    deny();
    const current = await directory.list(authority);
    expect(current.connections).toEqual([]);
    expect(current.providers[0]).toMatchObject({ available: false, reason: "Access revoked" });
  });
});
