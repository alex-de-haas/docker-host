import { fixtureCapabilities } from "./test-support/provider.js";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { AgentRunInput } from "@hosty-sdk/app/agent";
import type { HarnessAdapter, HarnessRun } from "./internal/harness/adapter.js";
import { trackedAdapter } from "./tracked-adapter.js";
import { TrackedNativeProcesses } from "./tracked-process.js";
import type { AgentConnections } from "./internal/connections/registry.js";
import type { ProviderAuthority } from "./core.js";
import { ProviderStore, type VerifiedOperation } from "./store.js";
import { ProviderController } from "./controller.js";
import { NativeExecution } from "./native-driver.js";
import { AttachmentStore } from "./attachments.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function fixture(options: { sdkError?: Error; supported?: boolean; stopped?: boolean } = {}) {
  const order: string[] = [];
  const sdkStop = vi.fn(async () => { order.push("sdk"); if (options.sdkError) throw options.sdkError; });
  const run = { stop: vi.fn(async () => {}), ...(options.supported === false ? {} : { stopAndWait: sdkStop }) } as unknown as HarnessRun;
  const adapter = { name: "fixture", capabilities: {}, start: () => run } as unknown as HarnessAdapter;
  const processes = { transport: {}, confirmSdkStop: vi.fn(async () => { order.push("marker"); }),
    stop: vi.fn(async () => { order.push("receipts"); return { stopped: options.stopped ?? true, allClosed: true }; }) };
  const wrapped = trackedAdapter(adapter, processes as unknown as TrackedNativeProcesses).start({} as never);
  return { wrapped, run, processes, order };
}
it("requires SDK stop and owned receipts before returning a confirmed stop", async () => {
  const f = fixture(); await f.wrapped.stopAndWait!();
  expect(f.order).toEqual(["sdk", "marker", "receipts"]);
});
it("cleans up owned processes but never replaces an unknown SDK stop with group receipts", async () => {
  const error = new Error("SDK native stop unknown"), f = fixture({ sdkError: error });
  await expect(f.wrapped.stopAndWait!()).rejects.toBe(error);
  expect(f.processes.confirmSdkStop).not.toHaveBeenCalled();
  expect(f.order).toEqual(["sdk", "receipts"]);
});
it("cannot confirm a best-effort stop when the SDK has no supported wait operation", async () => {
  const f = fixture({ supported: false });
  await expect(f.wrapped.stopAndWait!()).rejects.toMatchObject({ code: "exit_unconfirmed" });
  expect(f.run.stop).toHaveBeenCalledOnce(); expect(f.processes.confirmSdkStop).not.toHaveBeenCalled();
  expect(f.processes.stop).toHaveBeenCalledOnce();
});
it("keeps incomplete owned tree evidence unknown even after a successful SDK wait", async () => {
  const f = fixture({ stopped: false });
  await expect(f.wrapped.stopAndWait!()).rejects.toMatchObject({ code: "exit_unconfirmed" });
  expect(f.processes.confirmSdkStop).toHaveBeenCalledOnce();
});
it("always disposes a pre-start probe without recording SDK completion, including cleanup failure", async () => {
  const dispose = vi.fn(async () => {}), failure = new Error("Receipt storage unavailable");
  const adapter = { name: "fixture", capabilities: {}, dispose } as unknown as HarnessAdapter;
  const processes = { stop: vi.fn(async () => { throw failure; }), confirmSdkStop: vi.fn() };
  await expect(trackedAdapter(adapter, processes as unknown as TrackedNativeProcesses).dispose!()).rejects.toBe(failure);
  expect(dispose).toHaveBeenCalledOnce(); expect(processes.confirmSdkStop).not.toHaveBeenCalled();
});
it.each([true, false])("retains public capacity, the account claim and workspace lease when SDK startup throws (native spawn: %s)", async spawn => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hosty-startup-proof-")); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, "account"), worktree = path.join(directory, "worktree"); await mkdir(home); await mkdir(worktree);
  const provider = { appId: "independent.provider", installationId: "instance", key: "execution" }, actor: VerifiedOperation = { userId: "user", principalId: "principal", callerAppId: "independent.consumer", callerInstallation: "consumer", admissionRef: "original-grant", provider, operation: "runs.start" };
  const workspaceId = "f".repeat(64), authority = { admit: vi.fn(async () => ({})), renew: vi.fn(async () => ({})), workspace: vi.fn(async (_ref, operation) => operation === "resolve" ? { id: workspaceId, revision: "1", path: worktree } : {}), skills: vi.fn() } as unknown as ProviderAuthority;
  let claims = 0;
  const adapter: HarnessAdapter = { name: "throwing-sdk", capabilities: { questions: true, appMcp: true, liveReconfigure: true, autoAllow: true, denyReason: true }, probe: async () => ({ available: true }), start: options => {
    if (spawn) { const child = options.processTransport!.spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { command: process.execPath, cwd: worktree, env: { PATH: process.env.PATH, HOME: home } }); child.stdout.resume(); child.stderr.resume(); }
    throw new Error("SDK startup threw after initialization");
  } };
  const connections = { binding: async () => ({ connectionId: "account", connectionRevision: 1, harnessKind: "fixture-engine" }), reserve: async () => { claims++; return () => { claims--; }; }, prepareAdapter: async () => adapter, executionHome: async () => home, shutdown: async () => {} } as unknown as AgentConnections;
  const store = new ProviderStore(path.join(directory, "sessions"), provider); await store.initialize();
  const controller = new ProviderController(store, authority, connections, fixtureCapabilities, 1), driver = new NativeExecution(controller, store, authority, connections, new AttachmentStore(path.join(directory, "assets"), provider), directory, () => "http://127.0.0.1:1");
  controller.driver = driver; await driver.initialize(); cleanup.push(() => controller.close());
  const sessionId = randomUUID(), create = { configuration: { connection: { id: "account", revision: "1" } } }; await controller.createSession(sessionId, create, JSON.stringify(create), actor);
  const id = randomUUID(), input: AgentRunInput = { expectedSessionRevision: "1", configurationRevision: "1", continuation: "start", input: { text: "Begin" }, resources: [{ kind: "worktree", id: workspaceId, revision: "1" }] };
  await controller.startRun(sessionId, id, input, JSON.stringify(input), actor);
  await vi.waitFor(async () => expect((await controller.snapshot(id)).state).toBe("unknown"), { timeout: 10000, interval: 20 });
  const snapshot = await controller.snapshot(id); expect(snapshot.stopConfirmed).toBe(false); expect(claims).toBe(1); expect(driver.engine.occupied).toBe(1);
  expect((await store.load(sessionId)).session.activeRun?.id).toBe(id); expect((await store.run(id)).record.workspaces?.[0]?.id).toBe(workspaceId);
  expect((authority.workspace as ReturnType<typeof vi.fn>).mock.calls.some(call => call[1] === "release_all")).toBe(false);
  expect(await TrackedNativeProcesses.readEvidence(directory, id, snapshot.generation)).toMatchObject({ stopped: false, sealed: true, spawnCount: spawn ? 1 : 0 });
  const second = randomUUID(); await controller.createSession(second, create, JSON.stringify(create), actor);
  await expect(controller.startRun(second, randomUUID(), { ...input, resources: [] }, JSON.stringify({ ...input, resources: [] }), actor)).rejects.toMatchObject({ code: "provider_busy" });
});
