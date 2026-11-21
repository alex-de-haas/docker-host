import { fixtureCapabilities } from "./test-support/provider.js";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
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
  const connections = { list: vi.fn(async () => ({ connections: [{ id: "account", revision: 1, available: true }] })), binding: vi.fn(async () => ({ connectionId: "account", connectionRevision: 1, harnessKind: "fixture-engine" })) } as unknown as AgentConnections;
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

async function reinstall() {
  const f = await fixture(), runId = randomUUID();
  const old = await f.store.load(f.sessionId, actor);
  old.nativeId = randomUUID();
  old.session.nativeState = "available";
  const prior = f.store.makeRun(old, runId, actor, "original-input");
  prior.snapshot.state = "succeeded"; prior.snapshot.phase = "terminal"; prior.snapshot.stopConfirmed = true;
  old.runs[runId] = prior;
  await f.store.save(old);
  const newProvider = { ...provider, installationId: "replacement" };
  const currentActor = { ...actor, provider: newProvider, admissionRef: "current-grant" };
  const store = new ProviderStore(f.store.directory, newProvider); await store.initialize();
  const inspectNativeContext = vi.fn(async (): Promise<"available" | "missing"> => "available");
  const connections = Object.assign(f.controller.connections, { inspectNativeContext });
  const controller = new ProviderController(store, f.controller.authority, connections,
    { ...fixtureCapabilities, capabilities: [...fixtureCapabilities.capabilities, "session.reconnect"] });
  const configure = { requestId: randomUUID(), expectedSessionRevision: old.session.revision, requiredCapabilities: ["session.reconnect"],
    configuration: old.session.configuration! };
  return { ...f, original: f.store, controller, store, inspectNativeContext, configure, old, runId, newProvider, currentActor };
}

it("confirms only the owner's prior native thread and promotes an unchanged configuration once with current authority", async () => {
  const f = await reinstall(), { sessionId, controller, configure, currentActor } = f;
  for (const key of ["userId", "principalId", "callerAppId", "callerInstallation"] as const)
    await expect(controller.readSession(sessionId, { ...currentActor, [key]: "other" })).rejects.toMatchObject({ code: "session_not_found" });
  for (const providerChange of [{ implementationId: "other" }, { key: "other" }, { appId: "other" }]) {
    const other = { ...f.newProvider, ...providerChange };
    const store = new ProviderStore(f.store.directory, other); await store.initialize();
    const foreign = new ProviderController(store, controller.authority, controller.connections, controller.capabilities);
    await expect(foreign.readSession(sessionId, { ...currentActor, provider: other })).rejects.toMatchObject({ code: "session_not_found" });
  }
  expect(f.inspectNativeContext).not.toHaveBeenCalled();
  await expect(controller.readSession(sessionId, currentActor)).resolves.toMatchObject({ ref: { provider: f.newProvider, id: sessionId }, nativeState: "available" });
  expect(f.inspectNativeContext).toHaveBeenCalledWith(sessionId, f.old.nativeId);
  await expect(f.store.load(sessionId, currentActor)).rejects.toMatchObject({ code: "session_not_found" });
  const command = () => controller.configureSession(sessionId, configure, JSON.stringify(configure), currentActor);
  const [a, b] = await Promise.all([command(), command()]);
  expect(b).toEqual(a); expect(a.configurationRevision).toBe("2");
  const promoted = await f.store.load(sessionId, currentActor);
  expect(promoted.nativeId).toEqual(f.old.nativeId); expect(promoted.runs).toEqual({});
  expect(promoted.configurations["2"]?.pinRequestId).toBe(configure.requestId);
  expect(promoted.priorRunIds).toEqual([f.runId]);
  const archives = path.join(f.store.directory, "prior-installations"), [directory] = await readdir(archives);
  const archived = JSON.parse(await readFile(path.join(archives, directory!, sessionId + ".json"), "utf8"));
  expect(archived.runs[f.runId].snapshot.ref.provider).toEqual(provider);
  expect(archived.runs[f.runId].admissionRef).toBe(actor.admissionRef);
  const again = new ProviderStore(f.store.directory, f.newProvider); await again.initialize();
  await expect(again.run(f.runId, currentActor)).rejects.toMatchObject({ code: "run_not_found" });
  expect(() => again.makeRun(promoted, f.runId, currentActor, "new-request")).toThrow("already retained");
});

it("keeps missing, unavailable, changed-account and still-claimed native contexts distinct", async () => {
  const f = await reinstall(), { controller, configure, currentActor, sessionId } = f;
  f.inspectNativeContext.mockResolvedValueOnce("missing").mockRejectedValueOnce(new Error("native unavailable")).mockResolvedValueOnce("missing");
  await expect(controller.readSession(sessionId, currentActor)).resolves.toMatchObject({ nativeState: "missing" });
  await expect(controller.readSession(sessionId, currentActor)).rejects.toMatchObject({ code: "continuity_unavailable" });
  await expect(controller.configureSession(sessionId, configure, JSON.stringify(configure), currentActor)).rejects.toMatchObject({ code: "native_session_missing" });
  const config = { ...configure, configuration: { ...configure.configuration, connection: { id: "another-account", revision: "1" } } };
  await expect(controller.configureSession(sessionId, config, JSON.stringify(config), currentActor)).rejects.toMatchObject({ code: "connection_fixed" });
  vi.mocked(controller.connections.binding).mockResolvedValueOnce({ connectionId: "account", connectionRevision: 2, harnessKind: "fixture-engine" });
  await expect(controller.readSession(sessionId, currentActor)).rejects.toMatchObject({ code: "connection_fixed" });
  vi.mocked(controller.connections.list).mockResolvedValueOnce({ connections: [], defaultId: null });
  await expect(controller.readSession(sessionId, currentActor)).rejects.toMatchObject({ code: "connection_fixed" });
  const listed = await controller.connections.list();
  vi.mocked(controller.connections.list).mockResolvedValueOnce({ ...listed, connections: listed.connections.map(account => ({ ...account, available: false })) });
  await expect(controller.readSession(sessionId, currentActor)).rejects.toMatchObject({ code: "continuity_unavailable" });
  const old = await f.original.load(sessionId, actor);
  old.runs[f.runId]!.snapshot.effects = { certainty: "unknown", unresolvedCallIds: ["outcome"] };
  await f.original.save(old);
  await expect(controller.readSession(sessionId, currentActor)).rejects.toMatchObject({ code: "session_busy" });
  await expect(f.store.load(sessionId, currentActor)).rejects.toMatchObject({ code: "session_not_found" });
});
