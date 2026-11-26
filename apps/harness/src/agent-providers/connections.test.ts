import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentCapabilities, AgentConnectionUsage, AgentModelCatalog } from "@hosty-sdk/app/agent";
import type { HarnessAdapter, HarnessCapabilities } from "../harness/adapter.js";
import { AgentConsumerConnections } from "./connections.js";
import { AgentConnectionDirectory, agentSelectionId } from "./directory.js";
import type { AgentConnectionEntry, AgentConnectionSelection, AgentDirectoryBackend } from "./types.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const capabilityData: AgentCapabilities = {
  version: 2, eventVersions: ["agent-event.1"], capabilities: ["mcp.core", "decisions.questions", "decisions.deny-reason"],
  limits: { maxCommandBytes: 1024, maxEventBytes: 1024, maxSnapshotBytes: 1024, maxReplayBytes: 4096, replayRetentionMs: 1000, maxControls: 10, maxPageSize: 10 },
  configuration: { resumeCompatible: [] },
};
async function fixture(capabilities: string[] = []) {
  const data = await mkdtemp(path.join(os.tmpdir(), "hosty-consumer-connections-")); roots.push(data);
  const provider = { appId: "third.party.codex-looking-name", installationId: "installed-once", key: "worker" };
  let accounts: AgentConnectionEntry[] = [{ id: "real-account", revision: "9007199254740994", name: "Account", available: true, capabilities }];
  const authority = async () => "current-owner-authority";
  const discovery: AgentDirectoryBackend = {
    providers: async () => [{ ref: provider, displayName: "Unrelated provider", available: true }],
    connections: async () => structuredClone(accounts),
  };
  const directory = new AgentConnectionDirectory(data, discovery);
  const backend = {
    capabilities: vi.fn().mockResolvedValue(capabilityData),
    models: vi.fn().mockResolvedValue({ revision: "catalog-1", defaultModel: "model", models: [
      { id: "model", name: "Display model", reasoningEfforts: [null, "low", "high"], defaultReasoningEffort: "low" },
    ] } satisfies AgentModelCatalog),
    usage: vi.fn().mockResolvedValue({ observedAt: "2026-11-12T12:00:00Z", available: true,
      data: { state: "available", rows: [], observedAt: "2026-11-12T12:00:00Z" } } satisfies AgentConnectionUsage),
  };
  const adapter = vi.fn((selection: AgentConnectionSelection, mapped: HarnessCapabilities, name: string): HarnessAdapter => ({
    name, capabilities: mapped, probe: async () => ({ available: true }),
    start: () => { throw new Error("The connection facade must not start a run."); },
  }));
  const connections = new AgentConsumerConnections({ directory, backend, authority, adapter });
  return { connections, directory, provider, authority, backend, adapter, setAccounts: (value: AgentConnectionEntry[]) => { accounts = value; } };
}

describe("independent provider connection facade", () => {
  it("exposes neutral directory metadata and never auto-selects or infers a vendor from identity", async () => {
    const f = await fixture();
    const listing = await f.connections.list();
    expect(listing.connections).toEqual([expect.objectContaining({ kind: "agent", name: "Account", revision: "9007199254740994", provider: { ...f.provider, name: "Unrelated provider" } })]);
    expect(listing.defaultId).toBeNull();
    expect(await f.connections.binding()).toBeNull();
    expect(await f.connections.summary()).toMatchObject({ available: true, name: "Agent providers" });
    expect(await f.connections.binding()).toBeNull();
    expect(listing.connections[0]).not.toHaveProperty("auth");
    expect(listing.connections[0]).not.toHaveProperty("secretKey");
    expect(listing.connections[0]).not.toHaveProperty("hostDirectory");
  });

  it("pins the qualified installation and exact decimal account revision and rechecks before reservation", async () => {
    const f = await fixture();
    const id = (await f.connections.list()).connections[0]!.id;
    await f.connections.setDefault(id);
    const selected = (await f.connections.binding())!;
    expect(selected).toEqual({ connectionId: id, connectionIdentity: agentSelectionId(selected.selection!), connectionRevision: "9007199254740994", harnessKind: "agent",
      selection: { provider: f.provider, connection: { id: "real-account", revision: "9007199254740994" } } });
    expect(typeof await f.connections.reserve(selected)).toBe("function");
    const adapter = await f.connections.adapter(selected);
    expect(adapter.name).toBe("Unrelated provider");
    expect(f.adapter).toHaveBeenCalledWith(selected.selection, expect.objectContaining({ questions: true, appMcp: true, denyReason: true, autoAllow: false }), "Unrelated provider");

    f.setAccounts([{ id: "real-account", revision: "9007199254740995", name: "Account", available: true }]);
    await expect(f.connections.reserve(selected)).rejects.toMatchObject({ code: "provider_connection_changed" });
    await expect(f.connections.adapter({ ...selected, harnessKind: "codex" })).rejects.toMatchObject({ code: "provider_cutover_required" });
    expect(f.adapter).toHaveBeenCalledTimes(1);
  });

  it("resolves new catalog bindings while old executions still require the original installation", async () => {
    const f = await fixture();
    const row = (await f.connections.list()).connections[0]!;
    const original = (await f.connections.binding(row.id))!;
    const legacy = { ...original, connectionId: original.connectionIdentity!, connectionIdentity: undefined };
    expect(typeof await f.connections.reserve(legacy)).toBe("function");
    f.provider.installationId = "replacement";
    const current = (await f.connections.resolveCurrentBinding(legacy))!;
    expect(current.connectionId).toBe(row.id);
    expect(current.connectionIdentity).not.toBe(original.connectionIdentity);
    await f.connections.models(current.connectionId);
    expect(f.backend.models).toHaveBeenCalledWith(f.provider, original.selection!.connection.id, f.authority);
    for (const old of [legacy, original]) {
      await expect(f.connections.reserve(old)).rejects.toMatchObject({ code: "provider_connection_changed" });
      await expect(f.connections.adapter(old)).rejects.toMatchObject({ code: "provider_connection_changed" });
    }
    f.setAccounts([{ id: "real-account", revision: "2", name: "Account", available: false }]);
    expect(await f.connections.resolveCurrentBinding(original)).toBeNull();
    await expect(f.connections.binding(row.id)).rejects.toMatchObject({ code: "provider_unavailable" });
  });

  it("maps public models and treats undeclared usage as optional without a diagnostic request", async () => {
    const f = await fixture(), id = (await f.connections.list()).connections[0]!.id;
    expect(await f.connections.models(id)).toEqual({ revision: "catalog-1", defaultModel: "model", models: [
      { id: "model", label: "Display model", efforts: [{ id: "low", label: "low" }, { id: "high", label: "high" }], defaultEffort: "low" },
    ] });
    expect(f.backend.models).toHaveBeenCalledWith(f.provider, "real-account", f.authority);
    expect(await f.connections.usage(id)).toMatchObject({ state: "unsupported", rows: [] });
    expect(f.backend.usage).not.toHaveBeenCalled();
    f.setAccounts([{ id: "real-account", revision: "9007199254740994", name: "Account", available: true, capabilities: ["connections.usage"] }]);
    expect(await f.connections.usage(id)).toEqual({ state: "available", rows: [], observedAt: "2026-11-12T12:00:00Z", connectionRevision: "9007199254740994" });
    expect(f.backend.usage).toHaveBeenCalledWith(f.provider, "real-account", f.authority);
  });

  it("does not relabel replacement-account limits as the conversation's previous revision", async () => {
    const f = await fixture(["connections.usage"]), id = (await f.connections.list()).connections[0]!.id;
    f.backend.usage.mockResolvedValue({ observedAt: "2026-11-12T12:00:00Z", available: true,
      data: { state: "available", rows: [{ id: "new-account-quota", used: 25 }], observedAt: "2026-11-12T12:00:00Z", connectionRevision: "9007199254740995" } });
    expect(await f.connections.usage(id)).toMatchObject({ state: "unavailable", rows: [], connectionRevision: "9007199254740994" });
    expect(f.adapter).not.toHaveBeenCalled();
    f.backend.usage.mockResolvedValue({ observedAt: "2026-11-12T12:00:00Z", available: true,
      data: { state: "available", rows: [], observedAt: "2026-11-12T12:00:00Z", connectionRevision: "9007199254740994" } });
    expect(await f.connections.usage(id)).toMatchObject({ state: "available", rows: [], connectionRevision: "9007199254740994" });
  });

  it.each(["unsupported", "not_applicable", "unavailable"] as const)("preserves an explicit %s usage explanation without available meters", async state => {
    const f = await fixture(["connections.usage"]), id = (await f.connections.list()).connections[0]!.id;
    f.backend.usage.mockResolvedValue({ observedAt: "2026-11-12T12:00:00Z", available: false,
      data: { state, rows: [], observedAt: null, reason: state === "not_applicable" ? "local" : "unsupported_auth" } });
    expect(await f.connections.usage(id)).toMatchObject({ state, rows: [], observedAt: null, connectionRevision: "9007199254740994" });
  });

  it("rejects consumer-side account mutations and does not stop a provider during shutdown", async () => {
    const f = await fixture(), selected = (await f.connections.binding((await f.connections.list()).connections[0]!.id))!;
    const attempts = [
      f.connections.update({ secret: "must-not-be-forwarded" }), f.connections.remove("account"),
      f.connections.prepareDockerAuthorization("account"), f.connections.adoptLegacySession(selected, "native"),
      f.connections.startLogin("account"), f.connections.fetchLogin("attempt"), f.connections.cancelLogin("attempt"),
    ];
    await Promise.all(attempts.map(attempt => expect(attempt).rejects.toMatchObject({ code: "provider_owned" })));
    await f.connections.shutdown();
    expect(f.adapter).not.toHaveBeenCalled();
    expect(f.connections.remote).toBe(true);
  });
});
