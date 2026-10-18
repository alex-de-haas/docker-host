import assert from "node:assert/strict";
import test from "node:test";
import { assistantMessageFor, assistantSupportsContext, createAppSession, findAssistantGateways, pendingAssistantIntent, selectAssistant } from "../src/app/shell/assistant/assistant-client.ts";
import { getAppPanelTabs } from "../src/app/shell/surfaces/app-surface-tabs.ts";

const app = (id, extra = {}) => ({ id, installationId: `${id}-installed`, displayName: id, runtimeState: "running", confirmedRoles: ["assistant"],
  interfaces: { "assistant": [{ version: 1, capabilities: ["attachments"], url: `http://${id}/api` }] },
  panelSurfaces: [{ path: "/chat", embeddedUrl: `http://${id}/chat` }], ...extra });
test("interfaces and system labels do not grant assistant discovery or a panel", () => {
  const unconfirmed = app("fake", { confirmedRoles: [], system: true });
  assert.deepEqual(findAssistantGateways([unconfirmed]), []);
  assert.deepEqual(getAppPanelTabs([unconfirmed]), []);
  assert.deepEqual(findAssistantGateways([app("no-interface", { interfaces: {} })]), []);
  assert.deepEqual(getAppPanelTabs([app("no-interface", { interfaces: {} })]), []);
});
test("two confirmed assistants keep separate panels, including a stopped assistant", () => {
  const apps = [app("first"), app("second", { runtimeState: "stopped", interfaces: { "assistant": [{ version: 1, capabilities: ["attachments"], url: null }] } })];
  assert.deepEqual(getAppPanelTabs(apps).map(tab => [tab.appId, tab.embeddedUrl]), [["first", "http://first/chat"], ["second", null]]);
  assert.equal(findAssistantGateways(apps)[1].running, false);
});
test("one assistant is implicit only until a choice is made; stale choice never reroutes", () => {
  const assistants = findAssistantGateways([app("first"), app("second")]);
  assert.equal(selectAssistant(assistants, null), null);
  assert.equal(selectAssistant(assistants, "second").appId, "second");
  assert.equal(selectAssistant(assistants.slice(0, 1), "second"), null);
  assert.equal(selectAssistant(assistants.slice(0, 1), null).appId, "first");
  assert.equal(selectAssistant([], null), null);
});
for (const installationId of [undefined, null, ""]) {
  test(`missing installation metadata is actionable before selection, storage or handoff: ${installationId}`, async t => {
    const [gateway] = findAssistantGateways([app("assistant", { installationId })]);
    assert.match(gateway.problem, /Update Core/);
    assert.equal(selectAssistant([gateway], null), null);
    assert.equal(selectAssistant([gateway], "assistant"), null);
    assert.equal(await assistantSupportsContext(gateway), false);
    const writes = [], calls = [];
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { setItem: (...args) => writes.push(args) } });
    t.after(() => delete globalThis.sessionStorage);
    await assert.rejects(pendingAssistantIntent("alice", "assistant", "prompt", [], installationId), /Update Core/);
    await assert.rejects(createAppSession(gateway, async (...args) => { calls.push(args); }, "notes", "request"), /Update Core/);
    assert.deepEqual(writes, []);
    assert.deepEqual(calls, []);
  });
}


test("drafts and session links stay with their chosen assistant and actor", () => {
  const draft = { appId: "first", userId: "alice", message: { text: "private app context" }, nonce: 1 };
  assert.equal(assistantMessageFor(draft, "alice", "first", ["first", "second"]), draft);
  assert.equal(assistantMessageFor(draft, "alice", "second", ["first", "second"]), null);
  assert.equal(assistantMessageFor(draft, "bob", "first", ["first", "second"]), null);
  assert.equal(assistantMessageFor(draft, "alice", "first", ["second"]), null);
});
