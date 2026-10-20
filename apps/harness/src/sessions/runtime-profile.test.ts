import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "./manager.js";
import { SessionStore } from "./store.js";
import { SettingsStore } from "../settings/store.js";
import { AuditReporter } from "../audit.js";
import { FakeHarnessAdapter } from "../harness/fake.js";
import { SharedDockerWorker } from "../runtime/worker.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); vi.restoreAllMocks(); });

it.each(["native", "docker"] as const)("uses the installed %s profile for existing history and rejects the old setting", async mode => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hosty-profile-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const settings = new SettingsStore(root);
  const previous = mode === "docker" ? "native" : "docker";
  await settings.update({ executionMode: previous });
  const store = new SessionStore(root, path.join(root, "cache"));
  const make = (profile?: "native" | "docker") => new SessionManager(store, new FakeHarnessAdapter(),
    new AuditReporter(null, null, "hosty.harness"), root, settings, null, null, null, null, null, null, null, null, profile);
  const old = make();
  const record = await old.createSession({ createdBy: "admin" });
  record.harnessSessionId = "existing-provider-history";
  record.developmentLease = "released-but-reusable-source-lease";
  await store.saveRecord(record);
  await old.shutdown();
  const current = make(mode);
  cleanup.push(() => current.shutdown());
  expect(await current.getSession(record.id)).toMatchObject({ executionMode: mode, harnessSessionId: "existing-provider-history" });
  expect((await current.createSession({ createdBy: "admin" })).executionMode).toBe(mode);
  await expect(current.setExecutionMode(previous)).rejects.toMatchObject({ code: "runtime_selected_by_core" });
  expect((await store.readRecord(record.id))?.harnessSessionId).toBe("existing-provider-history");
  expect((await store.readRecord(record.id))?.developmentLease).toBe("released-but-reusable-source-lease");
});

it("Local runtime status does not require a Docker daemon", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hosty-local-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const worker = new SharedDockerWorker(root, path.join(root, "cache"));
  const health = vi.spyOn(worker, "health").mockRejectedValue(new Error("Docker is not installed"));
  const manager = new SessionManager(new SessionStore(root), new FakeHarnessAdapter(),
    new AuditReporter(null, null, "hosty.harness"), root, null, null, null, null, null, null, null, null, worker, "native");
  cleanup.push(() => manager.shutdown());
  expect(await manager.runtimeStatus()).toMatchObject({ defaultMode: "native" });
  expect(health).not.toHaveBeenCalled();
});
