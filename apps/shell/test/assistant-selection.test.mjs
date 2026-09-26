import assert from "node:assert/strict";
import test from "node:test";
import { assistantMessageFor, findAssistantGateways, selectAssistant } from "../src/app/shell/assistant/assistant-client.ts";
import { getAppPanelTabs } from "../src/app/shell/surfaces/app-surface-tabs.ts";

const app = (id, extra = {}) => ({ id, displayName: id, runtimeState: "running", confirmedRoles: ["assistant"],
  interfaces: { "ai-gateway": [{ url: `http://${id}/api` }] },
  panelSurfaces: [{ path: "/chat", embeddedUrl: `http://${id}/chat` }], ...extra });
test("interfaces and system labels do not grant assistant discovery or a panel", () => {
  const unconfirmed = app("fake", { confirmedRoles: [], system: true });
  assert.deepEqual(findAssistantGateways([unconfirmed]), []);
  assert.deepEqual(getAppPanelTabs([unconfirmed]), []);
  assert.deepEqual(findAssistantGateways([app("no-interface", { interfaces: {} })]), []);
  assert.deepEqual(getAppPanelTabs([app("no-interface", { interfaces: {} })]), []);
});
test("two confirmed assistants keep separate panels, including a stopped assistant", () => {
  const apps = [app("first"), app("second", { runtimeState: "stopped", interfaces: { "ai-gateway": [{ url: null }] } })];
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


test("drafts and session links stay with their chosen assistant and actor", () => {
  const draft = { appId: "first", userId: "alice", message: { text: "private app context" }, nonce: 1 };
  assert.equal(assistantMessageFor(draft, "alice", "first", ["first", "second"]), draft);
  assert.equal(assistantMessageFor(draft, "alice", "second", ["first", "second"]), null);
  assert.equal(assistantMessageFor(draft, "bob", "first", ["first", "second"]), null);
  assert.equal(assistantMessageFor(draft, "alice", "first", ["second"]), null);
});
