import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderStore, type VerifiedOperation } from "./store.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
const provider = { appId: "org.example.provider", installationId: "provider-installation", key: "default" };
const actor: VerifiedOperation = { userId: "original-user", principalId: "original-principal", callerAppId: "unrelated.consumer", callerInstallation: "caller-installation", admissionRef: "accepted-reference", operation: "runs.start", provider };
async function fixture(maxReplayBytes?: number) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hosty-store-regression-")); directories.push(directory);
  const store = new ProviderStore(directory, provider, maxReplayBytes); await store.initialize();
  const id = randomUUID(), configuration = { connection: { id: "account-1", revision: "1" } };
  await store.create(id, actor, JSON.stringify({ configuration }), { configuration }, { configuration, digest: "a".repeat(64), resolvedSkills: [] });
  const session = await store.load(id, actor); return { directory, store, session };
}
describe("durable public replay bounds", () => {
  it("accounts for the complete lifecycle snapshot before pruning its replay window", async () => {
    const { store, session } = await fixture(1000), run = store.makeRun(session, randomUUID(), actor, "{}");
    run.snapshot.messages = [{ id: "answer", role: "assistant", state: "complete", text: "output".repeat(1000) }];
    store.lifecycle(run);
    expect(Buffer.byteLength(JSON.stringify(run.events))).toBeLessThanOrEqual(1000);
    expect(run.firstSequence).toBe("2"); expect(run.snapshot.lastSequence).toBe("1");
    expect(run.snapshot.messages[0]!.text).toHaveLength(6000);
  });
  it("does not commit a sequence/revision when one event exceeds the public event budget", async () => {
    const { store, session } = await fixture(), run = store.makeRun(session, randomUUID(), actor, "{}");
    run.snapshot.messages = [{ id: "answer", role: "assistant", state: "complete", text: "x".repeat(1024 * 1024) }];
    expect(() => store.lifecycle(run)).toThrowError(expect.objectContaining({ code: "event_budget", status: 413 }));
    expect(run.snapshot).toMatchObject({ revision: "1", lastSequence: "0", cursor: "" }); expect(run.events).toEqual([]);
  });
  it("expires every old terminal replay after restart while retaining snapshot and deduplication evidence", async () => {
    const { directory, store, session } = await fixture(), old = new Date(Date.now() - 8 * 86400000).toISOString();
    for (let index = 0; index < 2; index++) {
      const run = store.makeRun(session, randomUUID(), actor, "original-input"); run.snapshot.stopConfirmed = true; run.snapshot.state = "succeeded"; run.snapshot.phase = "terminal";
      store.lifecycle(run); run.completedAt = old; run.snapshot.observedAt = old; for (const event of run.events) event.occurredAt = old;
      session.runs[run.snapshot.ref.id] = run;
    }
    await store.save(session); const reopened = new ProviderStore(directory, provider); await reopened.initialize();
    const saved = await reopened.load(session.id, actor);
    for (const run of Object.values(saved.runs)) { expect(run.events).toEqual([]); expect(run.hash).toBeDefined(); expect(run.snapshot.state).toBe("succeeded"); expect(run.firstSequence).toBe("2"); }
  });
  it("keeps active/unknown-stop and newly changed control observations beyond an old completion timestamp", async () => {
    const { store, session } = await fixture(), old = new Date(Date.now() - 8 * 86400000).toISOString();
    const run = store.makeRun(session, randomUUID(), actor, "{}"); store.lifecycle(run); run.completedAt = old; run.snapshot.observedAt = old; session.runs[run.snapshot.ref.id] = run; await store.save(session);
    await store.pruneReplay(run.snapshot.ref.id, actor); expect((await store.run(run.snapshot.ref.id)).record.events).toHaveLength(1);
    run.snapshot.stopConfirmed = true; store.lifecycle(run); await store.save(session);
    await store.pruneReplay(run.snapshot.ref.id, actor); expect((await store.run(run.snapshot.ref.id)).record.events).toHaveLength(2);
    await expect(store.pruneReplay(run.snapshot.ref.id, { ...actor, callerInstallation: "replacement" })).rejects.toMatchObject({ status: 404 });
  });
});
