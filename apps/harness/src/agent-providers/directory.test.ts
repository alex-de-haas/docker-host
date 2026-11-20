import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { AgentConnectionDirectory, agentSelectionId } from "./directory.js";
import type { AgentConnectionEntry, AgentDirectoryBackend, AgentProviderEntry } from "./types.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const authority = async () => "current-authority-supplied-only-to-Core";
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "hosty-agent-directory-")); roots.push(root);
  const provider: AgentProviderEntry = { ref: { appId: "unrelated.vendor.application", installationId: "first-installation", key: "coding" }, displayName: "Independent agent", available: true };
  let accounts: AgentConnectionEntry[] = [{ id: "account", revision: "1", name: "Work", available: true }];
  let failure = false;
  const backend: AgentDirectoryBackend = { providers: async () => [structuredClone(provider)], connections: async () => {
    if (failure) throw new Error("Access revoked"); return structuredClone(accounts);
  } };
  return { directory: new AgentConnectionDirectory(root, backend), provider, setAccounts: (value: AgentConnectionEntry[]) => { accounts = value; }, deny: () => { failure = true; } };
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
  it("pins installation and account revision without credentials or vendor identity", async () => {
    const { directory, provider, setAccounts } = await fixture();
    const account = (await directory.list(authority)).connections[0]!;
    await directory.setDefault(account.id, authority);
    expect(await directory.binding(undefined, authority)).toEqual({ provider: provider.ref, connection: { id: "account", revision: "1" } });
    setAccounts([{ id: "account", revision: "2", name: "Work", available: true }]);
    await expect(directory.binding(undefined, authority)).rejects.toMatchObject({ code: "provider_connection_changed" });
    const replacement = (await directory.list(authority)).connections[0]!;
    expect(replacement.id).not.toBe(account.id);
    await directory.setDefault(replacement.id, authority);
    provider.ref.installationId = "replacement-installation";
    await expect(directory.binding(undefined, authority)).rejects.toMatchObject({ code: "provider_connection_changed" });
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
