import assert from "node:assert/strict";
import test from "node:test";
import { assistantSupportsContext, createAppSession, pendingAssistantIntent } from "../src/app/shell/assistant/assistant-client.ts";
const gateway = { appId: "harness", installationId: "installed-1", baseUrl: "http://harness/api/assistant/v1", running: true, version: 1, capabilities: [] };
test("handoff uses the Shell server and retries transport uncertainty with the same identity", async () => {
  const calls = [];
  const send = async (url, body) => {
    calls.push({ url, body });
    if (calls.length === 1) throw new TypeError("response lost");
    return Response.json({ id: "session", result: { conversationId: "session", disposition: "draft", open: { endpoint: "web", path: "/chat" } } });
  };
  const session = await createAppSession(gateway, send, "notes", "request-1");
  assert.equal(session.id, "session");
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[0].url, "/api/assistant/handoff");
  assert.deepEqual(calls[0].body, { providerAppId: "harness", installationId: "installed-1", key: "default", requestId: "request-1", prompt: "", appIds: ["notes"] });
});
test("incompatible assistants are refused before a server request", async () => {
  const calls = [];
  const send = async (...args) => { calls.push(args); return Response.json({}); };
  assert.equal(await assistantSupportsContext({ ...gateway, version: 2 }), false);
  await assert.rejects(createAppSession({ ...gateway, version: 2 }, send, "notes", "request-1"), /version 1/);
  assert.deepEqual(calls, []);
});

test("uncertain intent identity survives repeated calls and is isolated by actor and assistant", async t => {
  const values = new Map();
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) } });
  t.after(() => delete globalThis.sessionStorage);
  const first = await pendingAssistantIntent("alice", "assistant", "prompt", ["b", "a"], "installed-1");
  assert.equal((await pendingAssistantIntent("alice", "assistant", "prompt", ["a", "b"], "installed-1")).requestId, first.requestId);
  assert.notEqual((await pendingAssistantIntent("bob", "assistant", "prompt", ["a", "b"], "installed-1")).requestId, first.requestId);
  await assert.rejects(pendingAssistantIntent("alice", "assistant", "prompt", ["a", "b"], "reinstalled"), /reinstalled/);
  first.complete();
  assert.notEqual((await pendingAssistantIntent("alice", "assistant", "prompt", ["a", "b"], "installed-1")).requestId, first.requestId);
});

for (const saved of ["legacy-request-id", '"legacy-request-id"', "null", "{}", '{"requestId":"broken","installationId":"installed-1"}']) {
  test(`obsolete pending intent is retired before explicit retry: ${saved}`, async t => {
    const values = new Map();
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) } });
    t.after(() => delete globalThis.sessionStorage);
    const first = await pendingAssistantIntent("alice", "assistant", "prompt", [], "installed-1");
    const key = [...values.keys()][0]; values.set(key, saved);
    await assert.rejects(pendingAssistantIntent("alice", "assistant", "prompt", [], "installed-1"), /obsolete.*Retry the action/);
    assert.equal(values.has(key), false);
    const retry = await pendingAssistantIntent("alice", "assistant", "prompt", [], "installed-1");
    assert.notEqual(retry.requestId, first.requestId);
    assert.deepEqual(JSON.parse(values.get(key)), { requestId: retry.requestId, installationId: "installed-1" });
  });
}
test("a reinstalled assistant requires a new explicit intent and stale completion cannot erase it", async t => {
  const values = new Map();
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) } });
  t.after(() => delete globalThis.sessionStorage);
  const old = await pendingAssistantIntent("alice", "assistant", "prompt", [], "installed-1");
  const other = await pendingAssistantIntent("bob", "assistant", "prompt", [], "installed-1");
  await assert.rejects(pendingAssistantIntent("alice", "assistant", "prompt", [], "installed-2"), /reinstalled.*Retry the action/);
  assert.equal(values.size, 1);
  const replacement = await pendingAssistantIntent("alice", "assistant", "prompt", [], "installed-2");
  assert.notEqual(replacement.requestId, old.requestId);
  old.complete();
  assert.equal((await pendingAssistantIntent("alice", "assistant", "prompt", [], "installed-2")).requestId, replacement.requestId);
  assert.equal((await pendingAssistantIntent("bob", "assistant", "prompt", [], "installed-1")).requestId, other.requestId);
  replacement.complete(); assert.equal(values.size, 1);
});
