import assert from "node:assert/strict";
import test from "node:test";
import { assistantSupportsContext, createAppSession } from "../src/app/shell/assistant/assistant-client.ts";

const gateway = { appId: "gateway", baseUrl: "http://gateway/api", running: true };
test("context-session creation refreshes auth, retries uncertain creation with the same id and sends no message", async t => {
  const calls = [], refreshes = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) return Response.json({}, { status: 401 });
    if (url.endsWith("/health")) return Response.json({ harness: { available: true, capabilities: { appContext: true } } });
    if (calls.length === 3) throw new TypeError("network response lost");
    return Response.json({ id: "created-session" });
  });
  const session = await createAppSession(gateway, async refresh => { refreshes.push(refresh); return { token: "synthetic" }; }, "notes", "request-1");
  assert.equal(session.id, "created-session");
  assert.deepEqual(refreshes, [false, true, false, false]);
  const creations = calls.filter(call => call.url.endsWith("/sessions"));
  assert.equal(creations.length, 2);
  assert.equal(creations[0].init.body, creations[1].init.body);
  assert.deepEqual(JSON.parse(creations[0].init.body), { appIds: ["notes"], clientRequestId: "request-1" });
  assert.ok(calls.every(call => !call.url.includes("/messages")));
});
test("an unavailable or older gateway cannot silently create an unbound session", async t => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async url => { calls.push(url); return Response.json({ harness: { available: true } }); });
  const issue = async () => ({ token: "synthetic" });
  assert.equal(await assistantSupportsContext(gateway, issue), false);
  await assert.rejects(createAppSession(gateway, issue, "notes", "request-1"), /unavailable/);
  assert.ok(calls.every(url => url.endsWith("/health")));
});
