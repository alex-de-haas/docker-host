import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { AgentApiError } from "@hosty-sdk/app/agent";
import { ProviderHarnessRun } from "./run.js";
import { publicProviderFixture, type PublicProviderFixture } from "./test-fixture.js";
import { currentAgentAuthority, withAgentAuthority } from "./context.js";

const fixtures: PublicProviderFixture[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fixture of fixtures.splice(0)) await fixture.close(); });
async function fixture() {
  const f = await publicProviderFixture(); fixtures.push(f);
  f.capabilities.capabilities.push("mcp.policy-update");
  const record = await f.manager.createSession({ createdBy: f.owner });
  await f.manager.postMessage(record.id, "Use the selected policy", f.credential, [], { actorUserId: f.owner, clientRequestId: randomUUID() });
  return f;
}
it("updates a running proxy policy without requesting native catalog reconfiguration", async () => {
  const f = await fixture();
  await f.manager.applyProviderPolicy();
  expect(f.controls).toMatchObject([{ runId: f.starts[0]!.runId, input: { command: "mcpPolicy", mcp: { targets: [] } } }]);
  expect(f.starts).toHaveLength(1);
});
it("reports an unconfirmed running policy update instead of acknowledging it as applied", async () => {
  const f = await fixture();
  vi.spyOn(ProviderHarnessRun.prototype, "configureMcp").mockRejectedValueOnce(new AgentApiError("connection_lost", "Reply was lost", 503, true));
  await expect(f.manager.applyProviderPolicy()).rejects.toMatchObject({ code: "provider_policy_unconfirmed", status: 503 });
  expect(f.controls).toEqual([]);
  expect(f.starts).toHaveLength(1);
});
it("keeps an explicitly unsupported native catalog expansion for the next turn", async () => {
  const f = await fixture();
  vi.spyOn(ProviderHarnessRun.prototype, "configureMcp").mockRejectedValueOnce(new AgentApiError("unsupported_capability", "New native targets require a new turn", 422));
  await expect(f.manager.applyProviderPolicy()).resolves.toBeUndefined();
  expect(f.controls).toEqual([]);
});
it("uses fresh retained authority for queued sends instead of a stale request's async scope", async () => {
  const f = await publicProviderFixture(); fixtures.push(f);
  const record = await f.manager.createSession({ createdBy: f.owner });
  // Production connection discovery uses the request-scoped authority callback; queued sends
  // outlive that original request and must explicitly establish their refreshed actor scope.
  (f.connections as unknown as { options: { authority: typeof currentAgentAuthority } }).options.authority = currentAgentAuthority;
  await withAgentAuthority(async () => "stale-originating-request", () => f.manager.postMessage(record.id, "Queued input", f.credential, [],
    { actorUserId: f.owner, clientRequestId: randomUUID() }));
  expect(f.starts).toHaveLength(1);
  const authorized = f.requests.filter(request => request.path.endsWith("/agent/authorize"));
  expect(authorized.length).toBeGreaterThan(0);
  expect(authorized.every(request => request.userToken === f.credential)).toBe(true);
});
