import { fixtureCapabilities } from "./test-support/provider.js";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { AgentConnections } from "./internal/connections/registry.js";
import type { ProviderAuthority } from "./core.js";
import { ProviderController, type ExecutionDriver } from "./controller.js";
import { ProviderStore, type VerifiedOperation } from "./store.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const provider = { appId: "independent.shutdown-provider", installationId: "installed-once", key: "default" };
const actor: VerifiedOperation = { userId: "user", principalId: "original-principal", callerAppId: "independent.consumer",
  callerInstallation: "consumer-installation", admissionRef: "admission", operation: "runs.start", provider };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(accept => { resolve = accept; }); return { promise, resolve }; }
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hosty-controller-close-")); directories.push(dir);
  const skillPath = path.join(dir, "skills"); await mkdir(skillPath);
  const store = new ProviderStore(path.join(dir, "sessions"), provider); await store.initialize();
  const authority = { skills: vi.fn(async () => ({ id: "a".repeat(64), path: skillPath, digest: "a".repeat(64), skills: [] })),
    admit: vi.fn(), renew: vi.fn() } as unknown as ProviderAuthority;
  const connections = { binding: vi.fn(async () => ({ connectionId: "account", connectionRevision: 1, harnessKind: "fixture-engine" })) } as unknown as AgentConnections;
  const controller = new ProviderController(store, authority, connections, fixtureCapabilities, 1);
  const driver: ExecutionDriver = { start: vi.fn(async () => {}), cancel: vi.fn(async () => {}), respond: vi.fn(async () => {}),
    control: vi.fn(async () => {}), synchronize: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  controller.driver = driver;
  const sessionId = randomUUID(), create = { configuration: { connection: { id: "account", revision: "1" }, skills: [] } };
  await controller.createSession(sessionId, create, JSON.stringify(create), actor);
  return { controller, store, driver, sessionId };
}

it("closes the driver before waiting for an accepted cancellation blocked on native interruption", async () => {
  const f = await fixture(), nativeStopped = deferred();
  vi.mocked(f.driver.cancel).mockImplementation(async () => nativeStopped.promise);
  vi.mocked(f.driver.close).mockImplementation(async () => { nativeStopped.resolve(); });
  const runId = randomUUID(), input = { expectedSessionRevision: "1", configurationRevision: "1", continuation: "start" as const, input: { text: "Hello" } };
  await f.controller.startRun(f.sessionId, runId, input, JSON.stringify(input), actor);
  const snapshot = await f.controller.snapshot(runId), request = { requestId: randomUUID(), expectedGeneration: snapshot.generation, expectedRevision: snapshot.revision };
  const receipt = await f.controller.cancel(runId, request, JSON.stringify(request), actor);
  expect(receipt.state).toBe("accepted");
  await vi.waitFor(() => expect(f.driver.cancel).toHaveBeenCalledOnce());
  const closing = f.controller.close();
  try {
    await vi.waitFor(() => expect(f.driver.close).toHaveBeenCalledOnce(), { timeout: 100 });
    await closing;
    const { record } = await f.store.run(runId);
    expect(record.controls[request.requestId]?.receipt.state).toBe("applied");
    // Draining a control is not process proof: only the real driver may publish confirmed exit.
    expect(record.snapshot.stopConfirmed).toBe(false);
    expect(record.snapshot.phase).toBe("cancelling");
    expect(f.driver.synchronize).toHaveBeenCalled();
  } finally { nativeStopped.resolve(); await closing; }
});

it("drains rejected background operations after driver shutdown without inventing success", async () => {
  const f = await fixture(); let reject!: (error: Error) => void;
  const pending = new Promise<void>((_resolve, fail) => { reject = fail; });
  f.controller.background(pending);
  vi.mocked(f.driver.close).mockImplementation(async () => { reject(new Error("Native shutdown remained unconfirmed.")); });
  const closing = f.controller.close();
  try {
    await vi.waitFor(() => expect(f.driver.close).toHaveBeenCalledOnce(), { timeout: 100 });
    await expect(closing).resolves.toBeUndefined();
  } finally { reject(new Error("Test cleanup")); await closing; }
});
