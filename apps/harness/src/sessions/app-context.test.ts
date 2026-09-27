import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "./manager.js";
import { SessionStore } from "./store.js";
import { AuditReporter } from "../audit.js";
import { ProviderDirectory } from "../settings/providers.js";
import type { HarnessAdapter, HarnessStartOptions } from "../harness/adapter.js";
import { captureContext, MAX_CONTEXT_BYTES, parseAppIds, withAppContext, readContextApps } from "./app-context.js";

let dir: string, store: SessionStore, manager: SessionManager;
let entries: Array<Record<string, unknown>> | null;
let directory: ProviderDirectory;
let starts: HarnessStartOptions[], sent: string[];
const adapter: HarnessAdapter = {
  name: "recording", capabilities: { questions: false, appMcp: false, liveReconfigure: false, autoAllow: false, denyReason: false },
  probe: async () => ({ available: true }),
  start: options => { starts.push(options); return { send: text => sent.push(text), stop: async () => {}, interrupt: async () => {}, setMcpServers: async () => false, resolveApproval: () => false, resolveQuestion: () => false }; },
};
const finishTurn = async (id: string) => {
  starts.at(-1)!.onEvent({ type: "result", status: "success" });
  await vi.waitFor(async () => expect((await manager.getSession(id))?.status).toBe("idle"));
};
const build = () => new SessionManager(store, adapter, new AuditReporter(null, null, "gateway"), dir, null, directory);
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "hosty-context-")); store = new SessionStore(dir, path.join(dir, "cache"));
  entries = [{ id: "notes", displayName: "Notes", runtimeState: "stopped" }, { id: "media", displayName: "Media", runtimeState: "running" }];
  directory = new ProviderDirectory(null, null, "gateway");
  vi.spyOn(directory, "readApps").mockImplementation(async () => entries);
  starts = []; sent = []; manager = build();
});
afterEach(async () => { await manager.shutdown(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

describe("session app context", () => {
  it("persists app order, deduplicates retries per actor and never starts a model on selection", async () => {
    const input = { createdBy: "admin", clientRequestId: "request-1", appIds: ["media", "notes", "media"] };
    const [a, b] = await Promise.all([manager.createSession(input), manager.createSession(input)]);
    expect(a.id).toBe(b.id); expect(a.appIds).toEqual(["media", "notes"]); expect(starts).toEqual([]);
    await manager.shutdown(); manager = build();
    expect((await manager.createSession(input)).id).toBe(a.id);
    await expect(manager.createSession({ ...input, appIds: [] })).rejects.toMatchObject({ status: 409 });
    expect((await manager.createSession({ ...input, createdBy: "other" })).id).not.toBe(a.id);
    await manager.deleteSession(a.id, "admin");
    expect(entries).toHaveLength(2);
    expect((await manager.createSession(input)).id).not.toBe(a.id);
  });
  it("rejects stale updates and messages, publishes revisions and applies changes only to subsequent turns", async () => {
    const record = await manager.createSession({ createdBy: "admin", appIds: ["notes"] });
    const events: unknown[] = [];
    await manager.subscribe(record.id, 0, event => events.push(event));
    await manager.postMessage(record.id, "inspect", undefined, [], { expectedRevision: 0 });
    const first = sent[0];
    const results = await Promise.allSettled([
      manager.setAppContext(record.id, ["media"], 0, "admin"), manager.setAppContext(record.id, [], 0, "other"),
    ]);
    expect(results.map(r => r.status)).toEqual(["fulfilled", "rejected"]);
    expect(events).toContainEqual(expect.objectContaining({ type: "app_context_changed", appContextRevision: 1 }));
    expect(sent).toEqual([first]);
    await finishTurn(record.id);
    await expect(manager.postMessage(record.id, "stale", undefined, [], { expectedRevision: 0 })).rejects.toMatchObject({ status: 409 });
    await manager.postMessage(record.id, "inspect again", undefined, [], { expectedRevision: 1 });
    expect(sent[1]).toContain('"id":"media"'); expect(sent[1]).not.toContain('"id":"notes"');
    expect(starts).toHaveLength(1); expect(starts[0]?.cwd).toContain(`/sessions/${record.id}/workspace`); expect(starts[0]?.mcpServers).toBeUndefined();
    await manager.setAppContext(record.id, [], 1, "admin");
    await finishTurn(record.id);
    await manager.postMessage(record.id, "general", undefined, [], { expectedRevision: 2 });
    expect(sent[2]).toContain('"apps":[]');
    const messages = (await store.readEvents(record.id)).filter(e => e.type === "user_message");
    expect(messages).toHaveLength(3); expect(messages[0]?.text).toBe("inspect");
    expect(messages[0]?.appContext).toMatchObject({ revision: 0, apps: [{ id: "notes" }] });
  });
  it("rejects concurrent sends while running and accepts a new message after completion", async () => {
    const record = await manager.createSession({ createdBy: "admin" });
    const results = await Promise.allSettled([
      manager.postMessage(record.id, "first"), manager.postMessage(record.id, "second"),
    ]);
    expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(sent).toEqual(["first"]);
    expect((await store.readEvents(record.id)).filter(event => event.type === "user_message")).toHaveLength(1);
    await finishTurn(record.id);
    await manager.postMessage(record.id, "second");
    expect(sent).toEqual(["first", "second"]);
  });
  it("serializes snapshot capture with selection changes", async () => {
    const record = await manager.createSession({ createdBy: "admin", appIds: ["notes"] });
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(directory.readApps).mockImplementationOnce(async () => { await wait; return entries; });
    const sending = manager.postMessage(record.id, "read", undefined, [], { expectedRevision: 0 });
    const change = manager.setAppContext(record.id, ["media"], 0, "admin");
    release(); await sending; await change;
    expect(sent[0]).toContain('"id":"notes"'); expect(sent[0]).not.toContain('"id":"media"');
  });
  it("distinguishes removed apps from discovery failure and requires explicit fallback", async () => {
    const record = await manager.createSession({ createdBy: "admin", appIds: ["notes"] });
    entries = [];
    await manager.postMessage(record.id, "inspect"); expect(sent[0]).toContain('"available":false');
    await expect(manager.setAppContext(record.id, ["missing"], 0, "admin")).rejects.toMatchObject({ status: 422 });
    entries = null;
    await finishTurn(record.id);
    await expect(manager.postMessage(record.id, "retry")).rejects.toMatchObject({ status: 503 }); expect(sent).toHaveLength(1);
    await manager.postMessage(record.id, "without details", undefined, [], { withoutDetails: true });
    expect(sent[1]).toContain('"resolution":"unavailable"');
    // Removing an unavailable association remains possible while discovery is down.
    await manager.setAppContext(record.id, [], 0, "admin");
  });
  it("reads legacy sessions as general context and does not infer bindings from legacy prose", async () => {
    const record = await manager.createSession({ createdBy: "admin", context: { appId: "notes" } });
    delete record.appIds; delete record.appContextRevision;
    await writeFile(path.join(dir, "sessions", record.id, "record.json"), JSON.stringify(record));
    await manager.shutdown(); manager = build();
    expect(await manager.getSession(record.id)).toMatchObject({ appIds: [], appContextRevision: 0 });
    await manager.postMessage(record.id, "hello"); expect(sent[0]).toBe("hello");
  });
  it("resolves display icons against browser-reachable Core and excludes them from model context", async () => {
    vi.stubEnv("HOSTY_CORE_PUBLIC_ORIGIN", "https://host.example.test");
    vi.stubEnv("HOSTY_CORE_ORIGIN", "http://core.internal:7070");
    entries = [
      { id: "notes", icon: "Network", iconUrl: "/api/apps/notes/assets/icon.svg" },
      { id: "media", iconUrl: "javascript:alert(1)" },
      { id: "external", iconUrl: "https://images.example.test/logo.png" },
    ];
    const apps = await readContextApps(directory);
    expect(apps[0]).toMatchObject({ icon: "Network", iconUrl: "https://host.example.test/api/apps/notes/assets/icon.svg" });
    expect(apps[1]?.iconUrl).toBeUndefined();
    expect(apps[2]?.iconUrl).toBe("https://images.example.test/logo.png");
    const snapshot = await captureContext(directory, ["notes"], 0, false);
    expect(snapshot.apps[0]).not.toHaveProperty("icon");
    expect(snapshot.apps[0]).not.toHaveProperty("iconUrl");
  });
  it("marks clipped fields and omits overlong endpoints instead of inventing a shortened URL", async () => {
    entries = [{ id: "notes", version: "v".repeat(81), interfaces: [{ name: "x".repeat(81), url: "https://example.test/" + "a".repeat(512) }] }];
    const snapshot = await captureContext(directory, ["notes"], 0, false);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.apps[0]).toMatchObject({ truncated: true, version: "v".repeat(80), interfaces: [{ name: "x".repeat(80), url: null }] });
  });
  it("bounds hostile metadata while retaining every selected id", async () => {
    entries = Array.from({ length: 16 }, (_, i) => ({ id: `app-${i}`, displayName: "x".repeat(500), description: "🦀".repeat(900), interfaces: Array.from({ length: 12 }, () => ({ name: "api", key: "default", url: "x".repeat(512) })) }));
    const ids = entries.map(e => e.id as string);
    const snapshot = await captureContext(directory, ids, 2, false);
    expect(snapshot.apps.map(app => app.id)).toEqual(ids); expect(snapshot.truncated).toBe(true);
    expect(Buffer.byteLength(withAppContext("", snapshot))).toBeLessThanOrEqual(MAX_CONTEXT_BYTES);
    expect(() => parseAppIds([...ids, "extra"])).toThrow(); expect(() => parseAppIds(["../source"])).toThrow();
  });
});

it("resynchronizes a missed live-only idle transition even when the replay cursor is current", async () => {
  const record = await manager.createSession({ createdBy: "admin" });
  await manager.postMessage(record.id, "inspect");
  expect((await manager.getSession(record.id))?.status).toBe("running");
  await finishTurn(record.id);
  const current = (await manager.getSession(record.id))!;
  const subscription = await manager.subscribe(record.id, current.lastEventSeq, () => {});
  expect(subscription.replay).toEqual([expect.objectContaining({ type: "session_status", status: "idle", seq: current.lastEventSeq })]);
  subscription.unsubscribe();
  await manager.postMessage(record.id, "next turn");
  const active = (await manager.getSession(record.id))!;
  const reconnect = await manager.subscribe(record.id, active.lastEventSeq, () => {});
  expect(reconnect.replay.at(-1)).toMatchObject({ type: "session_status", status: "running" });
  reconnect.unsubscribe();
});
