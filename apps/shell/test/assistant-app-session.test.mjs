import assert from "node:assert/strict";
import test from "node:test";
import { assistantSupportsContext, createAppSession, pendingAssistantIntent } from "../src/app/shell/assistant/assistant-client.ts";
const gateway = { appId: "harness", baseUrl: "http://harness/api/assistant/v1", running: true, version: 1, capabilities: [] };
test("handoff refreshes auth and retries uncertain preparation using the same identity", async t => {
  const calls = [], refreshes = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) return Response.json({}, { status: 401 });
    if (calls.length === 2) throw new TypeError("response lost");
    return Response.json(url.endsWith("/finalize") ? { conversationId: "session", result: { conversationId: "session", disposition: "draft", open: { endpoint: "web", path: "/chat" } } } : { handoffId: "prepared" });
  });
  const session = await createAppSession(gateway, async refresh => { refreshes.push(refresh); return { token: "synthetic" }; }, "notes", "request-1");
  assert.equal(session.id, "session");
  assert.deepEqual(refreshes, [false, true, false, false]);
  const preparations = calls.filter(call => call.url.endsWith("/handoffs"));
  assert.equal(preparations[0].init.body, preparations[2].init.body);
  assert.deepEqual(JSON.parse(preparations[0].init.body), { requestId: "request-1", prompt: "", appIds: ["notes"] });
  assert.ok(calls.every(call => !call.url.includes("/messages") && !call.url.includes("/health")));
});
test("incompatible assistants are refused before a request or an implicit selection", async t => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async url => { calls.push(url); return Response.json({}); });
  const issue = async () => ({ token: "synthetic" });
  assert.equal(await assistantSupportsContext({ ...gateway, version: 2 }, issue), false);
  await assert.rejects(createAppSession({ ...gateway, version: 2 }, issue, "notes", "request-1"), /version 1/);
  assert.deepEqual(calls, []);
});

test("uncertain intent identity survives repeated calls and is isolated by actor and assistant", async t => {
  const values = new Map();
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) } });
  t.after(() => delete globalThis.sessionStorage);
  const first = await pendingAssistantIntent("alice", "assistant", "prompt", ["b", "a"]);
  assert.equal((await pendingAssistantIntent("alice", "assistant", "prompt", ["a", "b"])).requestId, first.requestId);
  assert.notEqual((await pendingAssistantIntent("bob", "assistant", "prompt", ["a", "b"])).requestId, first.requestId);
  first.complete();
  assert.notEqual((await pendingAssistantIntent("alice", "assistant", "prompt", ["a", "b"])).requestId, first.requestId);
});
