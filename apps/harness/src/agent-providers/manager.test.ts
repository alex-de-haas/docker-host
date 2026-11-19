import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { prepareAgentCancel, prepareAgentRun } from "@hosty-sdk/app/agent/client";
import { publicProviderFixture, type PublicProviderFixture } from "./test-fixture.js";

const fixtures: PublicProviderFixture[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0).reverse()) await fixture.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function fixture() { const value = await publicProviderFixture(); fixtures.push(value); return value; }
async function chat(f: PublicProviderFixture) {
  const record = await f.manager.createSession({ createdBy: f.owner });
  const receipt = await f.manager.postMessage(record.id, "Public provider input", f.credential, [], { clientRequestId: randomUUID(), actorUserId: f.owner });
  expect(receipt).toMatchObject({ state: "accepted" });
  return record;
}
async function waitForStream(f: PublicProviderFixture, runId: string) {
  await vi.waitFor(() => expect(f.requests.some(request => request.path.includes(`/runs/${runId}/events`))).toBe(true));
}

describe("SessionManager public provider integration", () => {
  it("starts installation history without a user capability request after the first admission on an empty startup", async () => {
    const f = await publicProviderFixture(true); fixtures.push(f);
    await f.manager.recoverProviderRuns();
    f.behavior.capabilitiesTimeoutAfterStart = true;
    const record = await chat(f), runId = f.starts[0]!.runId;
    f.complete(runId, "First durable result");
    await vi.waitFor(async () => {
      expect((await f.store.readRecord(record.id))?.status).toBe("idle");
      expect((await f.store.readEvents(record.id)).filter(event => event.text === "First durable result")).toHaveLength(1);
    }, { timeout: 5000 });
    expect(f.requests.some(request => request.path.includes("/history/events"))).toBe(true);
    expect(f.requests.some(request => request.path.includes("/runs/" + runId + "/events"))).toBe(false);
    expect(f.controls).toHaveLength(0);
  });

  it.each(["denied", "timeout"] as const)("recovers a disconnected legacy observer after %s and imports the native outcome once", async issue => {
    const f = await fixture(); f.behavior.legacyHistoryRoute = true;
    const record = await chat(f), runId = f.starts[0]!.runId;
    await waitForStream(f, runId);
    f.behavior.snapshotIssue = issue; f.reconnect(runId);
    await vi.waitFor(async () => expect((await f.store.readRecord(record.id))?.providerHistoryContact).toMatchObject({
      reason: issue === "denied" ? "denied" : "unavailable", runId,
    }), { timeout: 5000 });
    f.complete(runId, "Native completion during outage");
    delete f.behavior.snapshotIssue;
    if (issue === "denied") {
      await expect(f.manager.refreshSessionCredentials(record.id, "another-owner", "other")).rejects.toThrow();
      await f.manager.refreshSessionCredentials(record.id, f.owner, "renewed-owner");
    }
    await vi.waitFor(async () => {
      const current = await f.store.readRecord(record.id);
      expect(current?.status).toBe("idle"); expect(current?.providerHistoryContact).toBeUndefined();
      expect((await f.store.readEvents(record.id)).filter(event => event.text === "Native completion during outage")).toHaveLength(1);
    }, { timeout: 6000 });
    expect(f.authorizations.filter(request => request.operation === "runs.start")).toHaveLength(1);
    expect(f.controls).toHaveLength(0);
  });

  it("lets the owner continue a legacy chat after read-only Refresh imports its offline completion", async () => {
    const f = await fixture(), chatRecord = await chat(f), runId = f.starts[0]!.runId;
    await waitForStream(f, runId);
    f.behavior.snapshotIssue = "denied"; f.reconnect(runId);
    await vi.waitFor(async () => expect((await f.store.readRecord(chatRecord.id))?.providerHistoryContact?.reason).toBe("denied"));
    f.complete(runId, "Finished while disconnected"); delete f.behavior.snapshotIssue;
    await f.manager.refreshProviderHistory(chatRecord.id, f.owner, f.credential);
    expect((await f.store.readRecord(chatRecord.id))?.status).toBe("idle");
    expect(f.starts).toHaveLength(1); expect(f.controls).toHaveLength(0);
    await f.manager.postMessage(chatRecord.id, "Explicit next turn", f.credential, [], { clientRequestId: randomUUID(), actorUserId: f.owner });
    expect(f.starts.map(start => start.sessionId)).toEqual([f.starts[0]!.sessionId, f.starts[0]!.sessionId]);
  });

  it("falls back to the legacy observer after an unavailable first probe and an explicit unsupported route", async () => {
    const f = await fixture(); f.behavior.failHistoryTokenOnce = true; f.behavior.legacyHistoryRoute = true;
    const record = await chat(f), runId = f.starts[0]!.runId;
    await vi.waitFor(() => expect(f.requests.some(r => r.path.includes("/runs/" + runId + "/events"))).toBe(true), { timeout: 5000 });
    f.complete(runId, "Legacy result");
    await vi.waitFor(async () => expect((await f.store.readRecord(record.id))?.status).toBe("idle"));
    expect((await f.store.readRecord(record.id))?.providerHistoryContact).toBeUndefined();
    expect(f.controls).toHaveLength(0); expect(f.starts).toHaveLength(1);
  });

  it("keeps the installation contact warning until the live stream opens after a successful catch-up page", async () => {
    const f = await publicProviderFixture(true); fixtures.push(f);
    const record = await chat(f), runId = f.starts[0]!.runId;
    const subscriptions = () => f.requests.filter(r => r.path.includes("/history/events") && r.accept === "text/event-stream").length;
    await vi.waitFor(() => expect(subscriptions()).toBe(1));
    f.behavior.rejectHistoryStream = true; f.disconnectHistory();
    await vi.waitFor(async () => expect((await f.store.readRecord(record.id))?.providerHistoryContact?.reason).toBe("unavailable"), { timeout: 5000 });
    const signals: unknown[] = [];
    const { unsubscribe } = await f.manager.subscribe(record.id, 0, event => {
      if (event.type === "session_status" && "providerHistoryContact" in event) signals.push(event.providerHistoryContact);
    });
    try {
      const before = subscriptions();
      await f.manager.refreshProviderHistory(record.id, f.owner);
      await vi.waitFor(() => expect(subscriptions()).toBeGreaterThan(before), { timeout: 5000 });
      expect(signals).not.toContain(null);
      f.behavior.rejectHistoryStream = false;
      await f.manager.refreshProviderHistory(record.id, f.owner);
      await vi.waitFor(async () => expect((await f.store.readRecord(record.id))?.providerHistoryContact).toBeUndefined());
      f.complete(runId, "Recovered live result");
      await vi.waitFor(async () => expect((await f.store.readRecord(record.id))?.status).toBe("idle"));
      expect(f.requests.some(r => r.path.includes("/runs/" + runId + "/events"))).toBe(false);
    } finally { unsubscribe(); }
  });

  it("refreshes a retained uncertain admission using only observed facts", async () => {
    const f = await fixture(), record = await chat(f), start = f.starts[0]!;
    await waitForStream(f, start.runId);
    await f.manager.shutdown();
    const retained = (await f.store.readProviderExecution(record.id))!;
    const request = prepareAgentRun(start.sessionId, start.runId, start.input);
    retained.mutations = { ...retained.mutations, [request.path]: request };
    await f.store.saveProviderExecution(record.id, retained);
    f.complete(start.runId, "Already finished");
    const restored = f.makeManager(), before = f.authorizations.length;
    await restored.manager.refreshSessionCredentials(record.id, f.owner, f.credential);
    await vi.waitFor(async () => expect((await restored.store.readRecord(record.id))?.status).toBe("idle"));
    expect(f.authorizations.slice(before).filter(value => value.method !== "GET")).toHaveLength(0);
    expect((await restored.store.readEvents(record.id)).filter(event => event.text === "Already finished")).toHaveLength(1);
  });

  it.each(["valid", "damaged"])("imports three chats of two owners after restart with a %s installation checkpoint", async checkpoint => {
    const f = await publicProviderFixture(true); fixtures.push(f);
    const open = async (owner: string) => {
      const chat = await f.manager.createSession({ createdBy: owner });
      const credential = owner === f.owner ? f.credential : "user:" + owner;
      await f.manager.postMessage(chat.id, "Start " + owner, credential, [], { clientRequestId: randomUUID(), actorUserId: owner });
      return { chat, run: f.starts.at(-1)!.runId };
    };
    const a = await open(f.owner), b = await open("second-operator"), c = await open(f.owner);
    const streamRequests = () => f.requests.filter(request => request.path.includes("/history/events") && request.accept === "text/event-stream");
    await vi.waitFor(() => expect(streamRequests()).toHaveLength(1));
    f.complete(a.run, "Result A");
    await vi.waitFor(async () => expect((await f.store.readRecord(a.chat.id))?.status).toBe("idle"));
    await f.manager.shutdown();
    const folder = path.join(f.store.dataDir, "provider-history");
    const checkpointPath = path.join(folder, (await readdir(folder)).find(name => name.endsWith(".json"))!);
    if (checkpoint === "damaged") await writeFile(checkpointPath, "{");
    const oldSnapshot = f.snapshot(a.run);
    oldSnapshot.messages = [{ id: "forged", state: "complete", role: "assistant", text: "Wrong recipient" }];
    f.publishHistory(oldSnapshot.sessionId, a.run, "second-operator", { kind: "snapshot", snapshot: oldSnapshot });
    f.emit(b.run, "extension", { namespace: "hosty.agent.answer", name: "answer.complete" });
    f.complete(b.run, "Result B while offline");
    f.complete(c.run, "Result C while offline");
    const restored = f.makeManager();
    const before = f.authorizations.length;
    await restored.manager.recoverProviderRuns();
    for (const [chat, value] of [[a, "Result A"], [b, "Result B while offline"], [c, "Result C while offline"]] as const) {
      await vi.waitFor(async () => {
        expect((await restored.store.readRecord(chat.chat.id))?.status).toBe("idle");
        const texts = (await restored.store.readEvents(chat.chat.id)).filter(event => event.type === "assistant_text").map(event => event.text);
        expect(texts).toEqual([value]);
      }, { timeout: 5000 });
    }
    await vi.waitFor(() => expect(streamRequests()).toHaveLength(2), { timeout: 5000 });
    if (checkpoint === "damaged") expect(await readFile(checkpointPath + ".invalid", "utf8")).toBe("{");
    expect(streamRequests()[1]!.path).toContain("after=feed-");
    expect(f.requests.filter(request => request.path.endsWith("/agent/history/token")).every(request =>
      request.authorization === "Bearer fixture-service" && request.userToken === null)).toBe(true);
    expect(f.requests.filter(request => /\/runs\/[^/]+\/events/.test(request.path))).toHaveLength(0);
    expect((await restored.store.readEvents(b.chat.id)).some(event => event.type === "session_status" && event.status === "suggesting")).toBe(false);
    expect(f.authorizations).toHaveLength(before);
    expect(f.starts).toHaveLength(3);
    expect(f.controls).toHaveLength(0);
    await expect(restored.manager.refreshSessionCredentials(b.chat.id, f.owner, f.credential)).rejects.toThrow("belongs to another user");
  });

  it("stops observing a provider after its last chat is deleted and resumes from the checkpoint on a new binding", async () => {
    const f = await publicProviderFixture(true); fixtures.push(f);
    const first = await chat(f), second = await chat(f);
    await vi.waitFor(() => expect(f.activeHistoryStreams()).toBe(1));
    f.complete(f.starts[0]!.runId, "First"); f.complete(f.starts[1]!.runId, "Second");
    await vi.waitFor(async () => {
      expect((await f.store.readRecord(first.id))?.status).toBe("idle");
      expect((await f.store.readRecord(second.id))?.status).toBe("idle");
    });
    await f.manager.deleteSession(first.id, f.owner, f.credential);
    expect(f.activeHistoryStreams()).toBe(1);
    await f.manager.deleteSession(second.id, f.owner, f.credential);
    await vi.waitFor(() => expect(f.activeHistoryStreams()).toBe(0));
    const before = f.requests.length;
    const third = await chat(f);
    await vi.waitFor(() => expect(f.activeHistoryStreams()).toBe(1));
    const catchup = f.requests.slice(before).find(request => request.path.includes("/history/events") && request.accept === "application/json");
    expect(catchup?.path).toContain("after=feed-");
    f.complete(f.starts[2]!.runId, "New binding");
    await vi.waitFor(async () => expect((await f.store.readEvents(third.id)).filter(event => event.text === "New binding")).toHaveLength(1));
  });

  it("retains the last observed run on history denial, refreshes read-only, and routes repaired facts to an old turn", async () => {
    const f = await publicProviderFixture(true); fixtures.push(f);
    const record = await chat(f), priorId = f.starts[0]!.runId;
    f.complete(priorId, "First answer");
    await vi.waitFor(async () => expect((await f.store.readRecord(record.id))!.status).toBe("idle"), { timeout: 5000 });
    await f.manager.postMessage(record.id, "Second turn", f.credential, [], { clientRequestId: randomUUID(), actorUserId: f.owner });
    const currentId = f.starts[1]!.runId;
    await vi.waitFor(async () => expect((await f.store.readHistoryRun(record.id, currentId))?.snapshot.ref.id).toBe(currentId), { timeout: 5000 });
    f.setHistoryDenied(true); f.disconnectHistory();
    await vi.waitFor(async () => expect((await f.store.readRecord(record.id))?.providerHistoryContact).toMatchObject({
      runId: currentId, reason: "denied", observedAt: expect.any(String),
    }), { timeout: 5000 });
    const historical = f.snapshot(priorId);
    historical.lastSequence = String(BigInt(historical.lastSequence) + 1n); historical.cursor = "cursor-" + historical.lastSequence;
    historical.revision = String(BigInt(historical.revision) + 1n); historical.result = { status: "succeeded", messageId: "late", text: "Recovered first turn" };
    historical.tools = [{ id: "prior-tool", name: "Read", state: "completed" }];
    f.publishHistory(historical.sessionId, priorId, f.owner, { kind: "snapshot", snapshot: historical });
    f.setHistoryDenied(false);
    await expect(f.manager.refreshProviderHistory(record.id, "other-user")).rejects.toThrow();
    await f.manager.refreshProviderHistory(record.id, f.owner);
    await vi.waitFor(async () => {
      const events = await f.store.readEvents(record.id);
      expect(events.filter(event => event.text === "Recovered first turn")).toHaveLength(1);
      expect(events.find(event => event.text === "Recovered first turn")).toMatchObject({ providerHistoryEarlier: true, providerSource: { runId: priorId } });
      expect(events.find(event => event.type === "tool_result" && event.providerHistoryEarlier === true)).toMatchObject({ status: "completed", output: "" });
      expect((await f.store.readRecord(record.id))?.providerHistoryContact).toBeUndefined();
    }, { timeout: 5000 });
    expect(await f.store.readProviderExecution(record.id)).toMatchObject({ runId: currentId, run: { state: "running" } });
    expect((await f.store.readRecord(record.id))?.status).toBe("running");
    expect(f.requests.some(request => /\/runs\/[^/]+\/events/.test(request.path))).toBe(false);
    expect(f.starts).toHaveLength(2); expect(f.controls).toHaveLength(0);
  });

  it.each(["provider-execution.json", "record.json"])("keeps another user's live history flowing and recovers a damaged %s without user credentials", async damagedFile => {
    const f = await publicProviderFixture(true); fixtures.push(f);
    const alice = await chat(f), aliceRun = f.starts[0]!.runId;
    const bob = await f.manager.createSession({ createdBy: "another-user" });
    await f.manager.postMessage(bob.id, "Other work", "user:another-user", [], { clientRequestId: randomUUID(), actorUserId: "another-user" });
    const bobRun = f.starts[1]!.runId;
    await vi.waitFor(async () => expect((await f.store.readHistoryRun(bob.id, bobRun))?.snapshot.state).toBe("running"), { timeout: 5000 });
    await f.manager.shutdown();

    // Damage one real stored destination across startup; retain the original bytes for recovery.
    const source = path.join(f.store.dataDir, "sessions", alice.id, damagedFile);
    const original = await readFile(source);
    await writeFile(source, "{");
    const broken = f.makeManager(), startCount = f.authorizations.length;
    const liveStreams = () => f.requests.filter(r => r.path.includes("/history/events") && r.accept === "text/event-stream").length;
    await broken.manager.recoverProviderRuns();
    await vi.waitFor(() => expect(liveStreams()).toBe(2), { timeout: 5000 });
    f.complete(aliceRun, "Held for Alice");
    f.complete(bobRun, "Delivered to Bob");
    const inbox = path.join(f.store.dataDir, "provider-history-inbox", alice.id);
    const positionDir = path.join(f.store.dataDir, "provider-history");
    await vi.waitFor(async () => {
      expect((await broken.store.readEvents(bob.id)).filter(e => e.type === "assistant_text").map(e => e.text)).toEqual(["Delivered to Bob"]);
      const checkpoint = JSON.parse(await readFile(path.join(positionDir, (await readdir(positionDir))[0]!), "utf8"));
      expect(checkpoint.cursor).toBe("feed-4");
      if (damagedFile === "provider-execution.json") expect((await readdir(inbox)).filter(f => f.endsWith(".json"))).toHaveLength(1);
      else expect(checkpoint.incomplete).toContain(alice.id);
    }, { timeout: 5000 });
    expect(liveStreams()).toBe(2);
    expect((await broken.store.readEvents(alice.id)).some(e => e.text === "Held for Alice")).toBe(false);
    await broken.manager.shutdown();
    await writeFile(source, original);

    const repaired = f.makeManager();
    await repaired.manager.recoverProviderRuns();
    await vi.waitFor(async () => {
      const texts = (await repaired.store.readEvents(alice.id)).filter(e => e.type === "assistant_text").map(e => e.text);
      expect(texts).toEqual(["Held for Alice"]);
      if (damagedFile === "provider-execution.json") expect(await readdir(inbox)).toEqual([]);
    }, { timeout: 5000 });
    expect((await repaired.store.readEvents(bob.id)).filter(e => e.type === "assistant_text").map(e => e.text)).toEqual(["Delivered to Bob"]);
    expect(f.authorizations).toHaveLength(startCount);
    expect(f.starts).toHaveLength(2); expect(f.controls).toHaveLength(0);
    expect(f.requests.some(r => /\/runs\/[^/]+\/events/.test(r.path))).toBe(false);
  });

  it("redelivers after a transcript commit failure boundary and an expired installation cursor without duplicate facts", async () => {
    const f = await publicProviderFixture(true); fixtures.push(f);
    const record = await chat(f), runId = f.starts[0]!.runId;
    await vi.waitFor(async () => expect((await f.store.readHistoryRun(record.id, runId))?.snapshot.state).toBe("running"), { timeout: 5000 });
    const save = f.store.saveHistoryRun.bind(f.store);
    let fail!: () => void;
    const failed = new Promise<void>(resolve => { fail = resolve; });
    vi.spyOn(f.store, "saveHistoryRun").mockImplementation(async (id, principal, snapshot) => {
      if (snapshot.stopConfirmed) { fail(); throw new Error("Interrupted after transcript commit"); }
      await save(id, principal, snapshot);
    });
    f.complete(runId, "Exactly once");
    await failed;
    await f.manager.shutdown();
    f.expireNextHistoryCursor();
    const restored = f.makeManager();
    await restored.manager.recoverProviderRuns();
    await vi.waitFor(async () => expect((await restored.store.readHistoryRun(record.id, runId))?.snapshot.stopConfirmed).toBe(true), { timeout: 5000 });
    const messages = (await restored.store.readEvents(record.id)).filter(event => event.type === "assistant_text");
    expect(messages.map(event => event.text)).toEqual(["Exactly once"]);
    expect(f.starts).toHaveLength(1); expect(f.controls).toHaveLength(0);
  });

  it.each([300, null])("restores the latest offline root context (%s) without inventing an intermediate usage ledger or replaying input", async latestCount => {
    const f = await fixture(), record = await chat(f), runId = f.starts[0]!.runId;
    await waitForStream(f, runId);
    const usage = (usedTokens: number) => ({ usedTokens, maxTokens: 1000, estimated: false, observedAt: "2026-11-13T12:00:00Z" });
    let expectedContextId: string | undefined, contextCommitted!: () => void;
    const committed = new Promise<void>(resolve => { contextCommitted = resolve; });
    // Session notifications follow durable append; subscribe before emitting instead of
    // racing the projection's queued disk writes against the polling helper's deadline.
    const { unsubscribe } = await f.manager.subscribe(record.id, 0, event => {
      if (event.type === "context_usage" && event.providerEventId === expectedContextId) contextCommitted();
    });
    let first!: ReturnType<typeof f.emit>;
    try {
      first = f.emit(runId, "context.updated", { usage: usage(100) });
      expectedContextId = `${runId}:context:${first.sequence}`;
      f.update(runId, { latestContext: { sequence: first.sequence, usage: usage(100) } });
      await committed;
      expect((await f.store.readEvents(record.id)).filter(event => event.type === "context_usage")).toHaveLength(1);
    } finally { unsubscribe(); }
    await f.manager.shutdown();
    f.emit(runId, "context.updated", { usage: usage(200) });
    const final = latestCount === null ? null : usage(latestCount);
    const latest = f.emit(runId, "context.updated", { usage: final });
    f.update(runId, { latestContext: { sequence: latest.sequence, usage: final } });
    f.complete(runId, "Completed while Harness was stopped");
    const restored = f.makeManager();
    await restored.manager.refreshSessionCredentials(record.id, f.owner, f.credential);
    await vi.waitFor(async () => expect((await restored.store.readRecord(record.id))!.status).toBe("idle"));
    let contexts = (await restored.store.readEvents(record.id)).filter(event => event.type === "context_usage");
    expect(contexts.map(event => event.usage)).toEqual([usage(100), final]);
    expect(contexts.map(event => event.providerEventId)).toEqual([`${runId}:context:${first.sequence}`, `${runId}:context:${latest.sequence}`]);
    await restored.manager.shutdown();
    const reopened = f.makeManager();
    await reopened.manager.refreshSessionCredentials(record.id, f.owner, f.credential);
    contexts = (await reopened.store.readEvents(record.id)).filter(event => event.type === "context_usage");
    expect(contexts.map(event => event.usage)).toEqual([usage(100), final]);
    expect(f.starts).toHaveLength(1); expect(f.controls).toEqual([]);
  });

  it("uses one context identity for live/snapshot delivery and lets only the root explicitly clear it", async () => {
    const f = await fixture(), record = await chat(f), runId = f.starts[0]!.runId;
    await waitForStream(f, runId);
    const usage = { usedTokens: 42, maxTokens: 1000, estimated: false, observedAt: "2026-11-13T12:00:00Z" };
    const root = f.emit(runId, "context.updated", { usage });
    f.update(runId, { latestContext: { sequence: root.sequence, usage } });
    f.emit(runId, "context.updated", { usage: { ...usage, usedTokens: 999 } }, { agentId: "child", parentAgentId: "root", parentToolCallId: "delegate" });
    const clear = f.emit(runId, "context.updated", { usage: null });
    f.update(runId, { latestContext: { sequence: clear.sequence, usage: null } });
    await vi.waitFor(async () => expect((await f.store.readEvents(record.id)).filter(event => event.type === "context_usage")).toHaveLength(2));
    const contexts = (await f.store.readEvents(record.id)).filter(event => event.type === "context_usage");
    expect(contexts.map(event => event.usage)).toEqual([usage, null]);
    expect(contexts.map(event => event.providerEventId)).toEqual([`${runId}:context:${root.sequence}`, `${runId}:context:${clear.sequence}`]);
    expect(contexts.every(event => event.providerGeneration === f.snapshot(runId).generation)).toBe(true);
    f.complete(runId); await vi.waitFor(async () => expect((await f.store.readRecord(record.id))!.status).toBe("idle"));
  });

  it("pins Harness's explicit platform package and introduction across consumer restart without a shared-worker prompt", async () => {
    vi.stubEnv("HOSTY_CORE_ORIGIN", "http://skills.test"); vi.stubEnv("HOSTY_APP_ID", "consumer"); vi.stubEnv("HOSTY_APP_SERVICE_TOKEN", "service");
    const id = "a".repeat(64), skill = { id, sourceKind: "core", coreVersion: "test-core", introductionPath: "references/introduction.md" };
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async url => String(url).endsWith("/skills/")
      ? Response.json({ skills: [skill] })
      : Response.json({ skill, path: skill.introductionPath, files: [skill.introductionPath], content: Buffer.from("Explicit Core platform guidance").toString("base64") }));
    const f = await fixture(), record = await chat(f), runId = f.starts[0]!.runId;
    const create = f.requests.find(request => request.method === "PUT" && /\/sessions\/[^/]+$/.test(request.path))!;
    const configuration = JSON.parse(create.body).configuration;
    expect(configuration.skills).toEqual([{ skillId: id }]);
    expect(configuration.instructions[0].text).toBe("Explicit Core platform guidance");
    expect(configuration.instructions.map((instruction: { text: string }) => instruction.text).join("\n")).toContain("independent provider");
    expect(JSON.stringify(configuration)).not.toContain("shared Docker worker");
    expect(fetch).toHaveBeenCalledTimes(2);
    f.complete(runId); await vi.waitFor(async () => expect((await f.store.readRecord(record.id))!.status).toBe("idle"));
    await f.manager.shutdown(); fetch.mockRejectedValue(new Error("A later Core package update must not rewrite this configuration"));
    const restored = f.makeManager(); await restored.manager.refreshSessionCredentials(record.id, f.owner, f.credential);
    await restored.manager.postMessage(record.id, "Resume the pinned configuration", f.credential, [], { actorUserId: f.owner, clientRequestId: randomUUID() });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(f.starts).toHaveLength(2); expect(f.starts[1]!.sessionId).toBe(f.starts[0]!.sessionId);
    expect(f.sessions.get(f.starts[0]!.sessionId)?.configuration).toEqual(configuration);
    expect((await restored.store.readRecord(record.id))!.providerPlatformContext).toMatchObject({ skillId: id, text: "Explicit Core platform guidance" });
  });

  it("projects completed text/tools and confirms exit through public HTTP/SSE identities", async () => {
    const f = await fixture(), record = await chat(f), started = f.starts[0]!;
    await waitForStream(f, started.runId);
    expect(started.runId).not.toBe(record.id);
    expect(started.sessionId).not.toBe(record.id);
    expect(started.input).toMatchObject({ input: { text: "Public provider input" }, continuation: "start", configurationRevision: "1" });
    f.update(started.runId, { messages: [{ id: "answer", role: "assistant", text: "Persisted answer", state: "complete" }],
      tools: [{ id: "tool", name: "read_file", input: { path: "example.txt" }, output: "Contents", state: "completed" }] });
    f.complete(started.runId, "Final answer");
    await vi.waitFor(async () => expect((await f.store.readRecord(record.id))!.status).toBe("idle"));
    const events = await f.store.readEvents(record.id);
    expect(events.filter(event => event.type === "assistant_text").map(event => event.text)).toEqual(["Persisted answer", "Final answer"]);
    expect(events.filter(event => event.type === "tool_use")).toHaveLength(1);
    expect(events.filter(event => event.type === "tool_result")).toMatchObject([{ output: "Contents", status: "completed" }]);
    expect(events.filter(event => event.type === "result")).toHaveLength(1);
    await vi.waitFor(async () => expect((await f.store.readProviderExecution(record.id))!.run).toMatchObject({ ref: { provider: f.provider, id: started.runId }, stopConfirmed: true }));
    expect(f.authorizations.some(request => request.operation === "runs.start" && request.runId === started.runId)).toBe(true);
    expect(f.requests.filter(request => request.path.startsWith("/api/agent/")).every(request => request.authorization === "Bearer exact-operation-fixture")).toBe(true);
  });

  it("detaches on consumer shutdown and reattaches after restart without cancellation or resubmission", async () => {
    const f = await fixture(), record = await chat(f), runId = f.starts[0]!.runId;
    await waitForStream(f, runId);
    f.update(runId, { messages: [{ id: "before", role: "assistant", text: "Before restart", state: "complete" }] });
    await vi.waitFor(async () => expect((await f.store.readEvents(record.id)).some(event => event.text === "Before restart")).toBe(true));
    await f.manager.shutdown();
    expect(f.controls).toEqual([]);
    f.complete(runId, "Completed while consumer was offline");
    const restored = f.makeManager();
    expect(await restored.manager.toolActivitySnapshot()).toMatchObject([{ userId: f.owner, status: "running" }]);
    await restored.manager.refreshSessionCredentials(record.id, f.owner, f.credential);
    await vi.waitFor(async () => expect((await restored.store.readRecord(record.id))!.status).toBe("idle"));
    expect(f.starts).toHaveLength(1);
    expect(f.controls).toEqual([]);
    const texts = (await restored.store.readEvents(record.id)).filter(event => event.type === "assistant_text").map(event => event.text);
    expect(texts).toEqual(["Before restart", "Completed while consumer was offline"]);
    expect((await restored.store.readProviderExecution(record.id))!.runId).toBe(runId);
  });

  it("keeps unknown exit fenced against deletion and another ordinary turn", async () => {
    const f = await fixture(), record = await chat(f), runId = f.starts[0]!.runId;
    await waitForStream(f, runId);
    f.update(runId, { state: "unknown", phase: "interrupted", stopConfirmed: false, freshness: "last_known", effects: { certainty: "unknown", unresolvedCallIds: ["effect"] } });
    f.behavior.cancel = "unavailable";
    await expect(f.manager.deleteSession(record.id, f.owner, f.credential)).rejects.toMatchObject({ code: "exit_unconfirmed" });
    expect(await f.store.readRecord(record.id)).not.toBeNull();
    expect((await f.store.readEvents(record.id)).some(event => event.type === "user_message")).toBe(true);
    expect((await f.store.readProviderExecution(record.id))!.runId).toBe(runId);
    await expect(f.manager.postMessage(record.id, "Do not duplicate", f.credential)).rejects.toThrow();
    expect(f.starts).toHaveLength(1);
    expect(f.controls).toMatchObject([{ runId, path: `/runs/${runId}/cancel` }]);
  });

  it("allows Stop to wait for slow public admission outside the manager queue and cancels its exact run", async () => {
    const f = await fixture(), record = await f.manager.createSession({ createdBy: f.owner });
    let release!: () => void; f.behavior.startGate = new Promise<void>(resolve => { release = resolve; });
    const posting = f.manager.postMessage(record.id, "Slow admission", f.credential, [], { clientRequestId: randomUUID(), actorUserId: f.owner });
    await vi.waitFor(() => expect(f.authorizations.some(request => request.operation === "runs.start")).toBe(true));
    const stopping = f.manager.cancelSession(record.id);
    await Promise.resolve(); release();
    await posting; await stopping;
    expect(f.starts).toHaveLength(1);
    expect(f.controls).toMatchObject([{ runId: f.starts[0]!.runId, path: `/runs/${f.starts[0]!.runId}/cancel` }]);
    expect((await f.store.readRecord(record.id))!.status).toBe("cancelled");
    expect((await f.store.readProviderExecution(record.id))!.run?.stopConfirmed).toBe(true);
  });

  it.each(["applied", "accepted", "unknown", "missing"] as const)("reconciles an accepted prediction control after terminal stream exit only when its receipt is %s", async outcome => {
    const f = await fixture(), record = await chat(f), runId = f.starts[0]!.runId;
    await waitForStream(f, runId); f.capabilities.capabilities.push("predictions"); f.behavior.deferPredictions = true;
    await f.manager.setSuggestionPreference(f.owner, { enabled: false, revision: (await f.manager.suggestionPreference(f.owner)).revision });
    const pending = Object.values((await f.store.readProviderExecution(record.id))!.mutations ?? {});
    expect(pending).toHaveLength(1);
    const original = pending[0]!, control = JSON.parse(original.body);
    expect(control).toMatchObject({ command: "predictions", enabled: false, expectedGeneration: f.snapshot(runId).generation });
    expect(f.receipts.get(control.requestId)?.state).toBe("accepted");
    f.complete(runId);
    await vi.waitFor(async () => expect((await f.store.readRecord(record.id))!.status).toBe("idle"));
    const terminalCursor = (await f.store.readProviderExecution(record.id))!.cursor;
    if (outcome === "missing") f.receipts.delete(control.requestId);
    else {
      const receipt = { ...f.receipts.get(control.requestId)!, state: outcome };
      f.receipts.set(control.requestId, receipt); f.emit(runId, "control.updated", { requestId: control.requestId, receipt });
    }
    // The SDK watcher has ended at the terminal run snapshot; this control event
    // remains outside its committed cursor and must be recovered through GET.
    expect((await f.store.readProviderExecution(record.id))!.cursor).toBe(terminalCursor);
    expect(Object.values((await f.store.readProviderExecution(record.id))!.mutations ?? {})).toEqual([original]);
    const next = f.manager.postMessage(record.id, "One intended continuation", f.credential, [], { actorUserId: f.owner, clientRequestId: randomUUID() });
    if (outcome === "applied") await expect(next).resolves.toMatchObject({ state: "accepted" });
    else await expect(next).rejects.toMatchObject({ code: "provider_request_unresolved" });
    expect(f.requests.some(request => request.method === "GET" && request.path.endsWith(`/runs/${runId}/controls/${control.requestId}`))).toBe(true);
    expect(f.controls).toHaveLength(1); expect(f.starts).toHaveLength(outcome === "applied" ? 2 : 1);
    expect(f.requests.filter(request => request.method === "POST" && request.path.endsWith(`/runs/${runId}/controls`)).map(request => request.body)).toEqual([original.body]);
    expect(Object.values((await f.store.readProviderExecution(record.id))!.mutations ?? {})).toEqual(outcome === "applied" ? [] : [original]);
  });

  it("preserves only the first known command result for an existing provider call while suggesting", async () => {
    const f = await fixture();
    f.capabilities.capabilities.push("predictions");
    const record = await f.manager.createSession({ createdBy: f.owner });
    await f.manager.postMessage(record.id, "Run the fixture command", f.credential, [], {
      clientRequestId: randomUUID(), actorUserId: f.owner, promptSuggestions: true,
    });
    const runId = f.starts[0]!.runId;
    await waitForStream(f, runId);
    const tool = { id: "background-command", source: { agentId: "root" }, name: "Bash", input: { command: "node fixture.mjs" },
      state: "completed" as const, output: "Background command started" };
    f.update(runId, { tools: [tool] });
    await vi.waitFor(async () => expect((await f.store.readEvents(record.id)).filter(event => event.type === "tool_result")).toHaveLength(1));
    f.emit(runId, "extension", { namespace: "hosty.agent.answer", name: "answer.complete" });
    await vi.waitFor(async () => expect((await f.store.readRecord(record.id))!.status).toBe("suggesting"));

    const terminal = { ...tool, output: "Late stdout", command: { status: "completed" as const, exitCode: 0 } };
    const unsolicited = { ...terminal, id: "unrecorded-tool" };
    const pending = f.update(runId, { phase: "finalizing", tools: [{ ...tool, command: { status: "unknown" } }, unsolicited] });
    await vi.waitFor(async () => expect((await f.store.readProviderExecution(record.id))!.cursor).toBe(pending.cursor));
    expect((await f.store.readEvents(record.id)).filter(event => event.type === "command_result")).toEqual([]);

    f.update(runId, { tools: [terminal, unsolicited] });
    await vi.waitFor(async () => expect((await f.store.readEvents(record.id)).filter(event => event.type === "command_result")).toHaveLength(1));
    f.update(runId, { tools: [{ ...terminal, command: { status: "failed", exitCode: 1 } }, unsolicited] });
    f.complete(runId, "Final answer during suggestions");
    await vi.waitFor(async () => expect((await f.store.readRecord(record.id))!.status).toBe("idle"));

    const events = await f.store.readEvents(record.id);
    expect(events.filter(event => event.type === "tool_use")).toHaveLength(1);
    expect(events.filter(event => event.type === "command_result")).toMatchObject([{
      toolUseId: events.find(event => event.type === "tool_use")!.toolUseId, status: "completed", exitCode: 0,
      providerSource: { runId, generation: f.snapshot(runId).generation, provider: f.provider, agentId: "root" },
    }]);
    expect(events.filter(event => event.type === "tool_result").map(event => event.output)).toEqual(["Background command started"]);
    expect(events.filter(event => event.type === "assistant_text").map(event => event.text)).toEqual(["Final answer during suggestions"]);
  });

  it.each(["succeeded", "failed"] as const)("keeps an unseen %s outcome when Stop first discovers native exit", async state => {
    const f = await fixture(), record = await chat(f), runId = f.starts[0]!.runId;
    await waitForStream(f, runId);
    // The user has not received the final frame. The provider's GET still sees the completed run.
    const snapshot = f.runs.get(runId)!;
    Object.assign(snapshot, { state, phase: "terminal", stopConfirmed: true, observedAt: new Date().toISOString(),
      messages: [{ id: "last", role: "assistant", text: "Last native answer", state: "complete" }],
      result: state === "succeeded" ? { status: state, text: "Last native answer", messageId: "last" }
        : { status: state, error: { code: "native_failure", message: "Native check failed", retryable: false } } });
    expect(await f.manager.cancelSession(record.id)).toBe(false);
    const events = await f.store.readEvents(record.id);
    expect(events.filter(event => event.type === "assistant_text").map(event => event.text)).toEqual(["Last native answer"]);
    expect(events.filter(event => event.providerEventId === runId + ":terminal")).toHaveLength(1);
    expect(events.some(event => event.type === "session_status" && event.status === "cancelled")).toBe(false);
    expect((await f.store.readRecord(record.id))!.status).toBe(state === "succeeded" ? "idle" : "failed");
    expect(f.controls).toHaveLength(0);
    expect(f.starts).toHaveLength(1);
  });

  it.each(["running", "failed-and-reattached"])("projects a stopped snapshot's tool output before cancellation without reopening %s", async mode => {
    const f = await fixture(), record = await chat(f), runId = f.starts[0]!.runId;
    let { manager, store } = f;
    await waitForStream(f, runId);
    const tool = { id: "native-command", source: { agentId: "root" }, name: "Bash", input: { command: "node harmless-timer.mjs" }, state: "running" as const };
    f.update(runId, { tools: [tool] });
    await vi.waitFor(async () => expect((await f.store.readEvents(record.id)).filter(event => event.type === "tool_use")).toHaveLength(1));
    if (mode === "failed-and-reattached") {
      f.update(runId, { state: "unknown", phase: "interrupted", freshness: "last_known", effects: { certainty: "unknown", unresolvedCallIds: [tool.id] } });
      await vi.waitFor(async () => expect((await store.readRecord(record.id))!.status).toBe("failed"));
      await manager.shutdown(); ({ manager, store } = f.makeManager());
      await manager.refreshSessionCredentials(record.id, f.owner, f.credential);
      f.update(runId, { tools: [{ ...tool, state: "unknown", output: "Command interrupted", command: { status: "unknown" } }] });
      await vi.waitFor(async () => expect((await store.readProviderExecution(record.id))!.cursor).toBe(f.snapshot(runId).cursor));
      expect((await store.readEvents(record.id)).filter(event => ["tool_result", "command_result"].includes(event.type))).toEqual([]);
    }
    // These SSE observations queue behind the manager's Stop lane. Its synchronous
    // public read already contains the terminal output before the observer catches up.
    f.behavior.beforeCancel = id => { f.update(id, { freshness: "current", effects: { certainty: "known", unresolvedCallIds: [] },
      tools: [{ ...tool, state: "unknown", output: "Command interrupted", command: { status: "unknown" } }] }); };
    await manager.cancelSession(record.id);
    await vi.waitFor(async () => expect((await store.readProviderExecution(record.id))!.cursor).toBe(f.snapshot(runId).cursor));
    const events = await store.readEvents(record.id), call = events.find(event => event.type === "tool_use")!;
    const output = events.find(event => event.type === "tool_result")!, command = events.find(event => event.type === "command_result")!;
    const cancelled = events.find(event => event.type === "session_status" && event.status === "cancelled")!;
    expect(output).toMatchObject({ toolUseId: call.toolUseId, status: "unknown", output: "Command interrupted" });
    expect(command).toMatchObject({ toolUseId: call.toolUseId, status: "unknown" }); expect(command).not.toHaveProperty("exitCode");
    expect(output.seq).toBeLessThan(cancelled.seq); expect(command.seq).toBeLessThan(cancelled.seq);
    expect(events.filter(event => event.seq > cancelled.seq && event.type === "session_status" && event.status === "running")).toEqual([]);
    expect(events.filter(event => event.type === "tool_use")).toHaveLength(1);
    expect(events.filter(event => event.type === "tool_result")).toHaveLength(1);
    expect(events.filter(event => event.type === "command_result")).toHaveLength(1);
    expect(events.filter(event => event.type === "session_status" && event.status === "cancelled")).toHaveLength(1);
    expect(call.providerGeneration).toBe(f.snapshot(runId).generation);
    expect(output.providerGeneration).toBe(call.providerGeneration); expect(command.providerGeneration).toBe(call.providerGeneration);
    const failed = events.find(event => event.type === "session_status" && event.status === "failed");
    if (failed) {
      expect(failed.providerObservation).toEqual({ runId, generation: call.providerGeneration, stopConfirmed: false });
      expect(events.filter(event => event.seq > failed.seq && event.type === "session_status" && event.status === "running")).toEqual([]);
    }
    expect(f.controls).toHaveLength(1); expect(f.starts).toHaveLength(1);
    expect((await store.readRecord(record.id))!.status).toBe("cancelled");
  });

  it("pins task barriers to the public run/session and preserves its exact control UUID on retry", async () => {
    const f = await fixture(), record = await chat(f), started = f.starts[0]!;
    const barrierId = randomUUID();
    expect(await f.manager.armTaskBarrier(record.id, f.owner, barrierId, "task_adoption", 1, "coordinator")).toBe(`hosty_task_barrier:${barrierId}:1`);
    await f.manager.advanceTaskBarrier(record.id);
    const barrier = (await f.store.readRecord(record.id))!.taskBarrier!;
    expect(barrier).toMatchObject({ runId: started.runId, checkpointSessionId: started.sessionId, state: "parked" });
    expect(barrier).not.toHaveProperty("nativeSessionId");
    expect(f.controls).toMatchObject([{ runId: started.runId, input: { command: "barrier", barrierId, expectedGeneration: f.snapshot(started.runId).generation } }]);
    const checkpoint = await f.manager.taskCheckpoint(record.id);
    expect(checkpoint).toMatchObject({ ref: { provider: f.provider, id: started.runId }, sessionId: started.sessionId, phase: "parked", stopConfirmed: true });
    await f.manager.advanceTaskBarrier(record.id);
    expect(f.controls).toHaveLength(1);
  });

  it("merges an observer watermark into the latest durable sidecar without erasing a concurrent command", async () => {
    const f = await fixture(), record = await chat(f), runId = f.starts[0]!.runId;
    const before = (await f.store.readProviderExecution(record.id))!, observed = structuredClone(before);
    const request = prepareAgentCancel(runId, { requestId: randomUUID(), expectedGeneration: f.snapshot(runId).generation, expectedRevision: "1" });
    await f.store.saveProviderExecution(record.id, { ...before, mutations: { retained: request } });
    observed.run = { ...f.snapshot(runId), revision: "2", lastSequence: "2", cursor: "cursor-2" }; observed.cursor = "cursor-2";
    await f.store.commitProviderObservation(record.id, observed);
    expect(await f.store.readProviderExecution(record.id)).toMatchObject({ cursor: "cursor-2", run: { revision: "2" }, mutations: { retained: request } });
  });

  it("refuses deletion until a stopped source's awaiting continuation is authoritatively fenced", async () => {
    const f = await fixture(), record = await chat(f), runId = f.starts[0]!.runId;
    await waitForStream(f, runId);
    f.complete(runId);
    await vi.waitFor(async () => expect((await f.store.readProviderExecution(record.id))!.run?.stopConfirmed).toBe(true));
    await f.manager.shutdown();
    const state = (await f.store.readProviderExecution(record.id))!, requestId = randomUUID(), reservedId = randomUUID();
    state.continuations = { [JSON.stringify([runId, requestId])]: { requestId, sourceRunId: runId, run: { provider: f.provider, id: reservedId }, state: "awaiting_authorization",
      input: state.lastRunInput!.input, deadline: state.lastRunInput!.deadline } };
    await f.store.saveProviderExecution(record.id, state);
    f.receipts.set(requestId, { requestId, state: "applied", run: { provider: f.provider, id: runId }, revision: f.snapshot(runId).revision,
      generation: f.snapshot(runId).generation, continuation: { run: { provider: f.provider, id: reservedId }, state: "awaiting_authorization" } });
    f.behavior.keepReservationAfterCancel = true;
    const restored = f.makeManager();
    await expect(restored.manager.deleteSession(record.id, f.owner, f.credential)).rejects.toMatchObject({ code: "stop_unconfirmed" });
    expect(await restored.store.readRecord(record.id)).not.toBeNull();
    expect(f.starts).toHaveLength(1);
    expect(f.controls).toMatchObject([{ runId, path: `/runs/${runId}/cancel` }]);
  });
});
