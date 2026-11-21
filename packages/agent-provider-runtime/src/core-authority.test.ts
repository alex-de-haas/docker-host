import { fixtureCapabilities } from "./test-support/provider.js";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CoreAuthority, type ProviderAuthority } from "./core.js";
import { ProviderStore, type VerifiedOperation } from "./store.js";
import { ProviderController } from "./controller.js";
const roots: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const provider = { appId: "independent.provider", installationId: "installation", key: "default" };
const actor: VerifiedOperation = { provider, userId: "user", principalId: "principal", callerAppId: "independent.consumer", callerInstallation: "consumer-installation", admissionRef: "admitted", operation: "runs.start" };
it("sends only provider service identity and the exact admitted business workflow to Core JSON", async () => {
  const timeout = vi.spyOn(AbortSignal, "timeout");
  const request = vi.fn(async () => Response.json({ state: "received" })); vi.stubGlobal("fetch", request);
  const authority = new CoreAuthority("http://core.test", provider.appId, "synthetic-own-service"), input = { requestId: randomUUID(), expectedRevision: 0, markdown: "Plan" };
  const source = { appId: "external.tasks", installationId: "different-installation", key: "tasks-source" };
  expect(await authority.workflow("original-admission", "task-plan", input, source)).toEqual({ state: "received" });
  expect(request.mock.calls[0]).toEqual(["http://core.test/api/internal/apps/independent.provider/agent/workflow", expect.objectContaining({
    method: "POST", redirect: "error", headers: { authorization: "Bearer synthetic-own-service", "content-type": "application/json" },
    body: JSON.stringify({ admissionRef: "original-admission", action: "task-plan", input, source }),
  })]);
  expect(request).toHaveBeenCalledOnce();
  expect(timeout).toHaveBeenCalledWith(120000);
});
it("allows Git fetch and publication time and reports a lost install response as uncertain", async () => {
  const timeout = vi.spyOn(AbortSignal, "timeout");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection closed")));
  const authority = new CoreAuthority("http://core.test", provider.appId, "synthetic-own-service");
  for (const action of ["skill-discover", "skill-install"]) {
    const call = authority.workflow("original-admission", action, {});
    await expect(call).rejects.toThrow(action === "skill-install" ? /skill_list.*commit.*paths/ : /Discover the source again/);
    expect(timeout).toHaveBeenLastCalledWith(180_000);
  }
});
it("normalizes the actual Core nullable introspection wire format without adding a constraint", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...actor, sessionId: null, runId: null, configurationDigest: null, ceiling: null })));
  const authority = new CoreAuthority("http://core.test", provider.appId, "synthetic-own-service"), verified = await authority.introspect("operation-token", "runs.start", "PUT", "/session/run", "hash");
  for (const key of ["sessionId", "runId", "configurationDigest", "ceiling"]) expect(verified).not.toHaveProperty(key);
  expect(verified).toMatchObject(actor);
});
it("accepts an absent nullable digest but still rejects a supplied wrong configuration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hosty-core-wire-")); roots.push(root);
  const store = new ProviderStore(path.join(root, "sessions"), provider); await store.initialize();
  const connections = { binding: async () => ({ connectionId: "account", connectionRevision: 1, harnessKind: "fixture-engine" }) } as never;
  const authority = { skills: vi.fn(async () => { throw new Error("A plain request needs no library grant"); }) } as unknown as ProviderAuthority;
  const controller = new ProviderController(store, authority, connections, fixtureCapabilities), start = vi.fn(async () => {});
  controller.driver = { start, cancel: async () => {}, respond: async () => {}, control: async () => {}, synchronize: async () => {}, close: async () => {} };
  const id = randomUUID(), create = { configuration: { connection: { id: "account", revision: "1" } } }; await controller.createSession(id, create, JSON.stringify(create), actor);
  const input = { expectedSessionRevision: "1", configurationRevision: "1", continuation: "start" as const, input: { text: "Plain independent consumer" } };
  await expect(controller.startRun(id, randomUUID(), input, JSON.stringify(input), { ...actor, configurationDigest: "e".repeat(64) })).rejects.toMatchObject({ code: "configuration_mismatch" });
  await controller.startRun(id, randomUUID(), input, JSON.stringify(input), { ...actor, configurationDigest: null } as unknown as VerifiedOperation);
  expect(start).toHaveBeenCalledOnce(); expect(authority.skills).not.toHaveBeenCalled(); await controller.close();
});
