import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SettingsStore } from "../settings/store.js";
import { McpToolPolicy, ruleKey, validRules } from "./policy.js";
let dir: string, settings: SettingsStore, policy: McpToolPolicy;
const notify = vi.fn(), settled = vi.fn();
const read = { name: "read", annotations: { readOnlyHint: true } }, write = { name: "merge" };
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "hosty-tool-policy-")); settings = new SettingsStore(dir);
  notify.mockResolvedValue(undefined); settled.mockResolvedValue(undefined);
  policy = new McpToolPolicy(settings, notify, settled, 200);
  await policy.catalog("app", "install-1", [write]);
});
afterEach(async () => { policy.close(); vi.resetAllMocks(); await rm(dir, { recursive: true, force: true }); });
const call = (id = "1", signal = new AbortController().signal) => policy.authorize("session", "app", "install-1", id, "merge", { head: "abc" }, signal);
it("migrates only read-only tools once and does not grant new tools or reinstallations", async () => {
  await settings.update({ mcpAutoAllow: { app: true }, mcpPolicyMigrated: [] });
  await policy.catalog("app", "install-1", [read, write]);
  expect(await policy.mode("app", "install-1", "read")).toBe("run");
  expect(await policy.mode("app", "install-1", "merge")).toBe("ask");
  await policy.catalog("app", "install-1", [read, write, { name: "new", annotations: { readOnlyHint: true } }]);
  expect(await policy.mode("app", "install-1", "new")).toBe("ask");
  await policy.update({ [ruleKey("app", "merge")]: { identity: "install-1", mode: "run" } });
  await policy.catalog("app", "install-2", [read, write]);
  expect(await policy.mode("app", "install-2", "merge")).toBe("ask");
});
it("does not lose rules when different provider catalogs arrive concurrently", async () => {
  await Promise.all(Array.from({ length: 20 }, (_, n) => policy.catalog(`app-${n}`, `install-${n}`, [write])));
  expect(policy.snapshot()).toHaveLength(21);
  expect((await settings.read()).mcpPolicyMigrated).toHaveLength(21);
});
it("runs a write unprompted, audits it and refuses replay with the same RPC identity", async () => {
  await policy.catalog("app", "install-1", [write]);
  await policy.update({ [ruleKey("app", "merge")]: { identity: "install-1", mode: "run" } });
  await call(); expect(notify).not.toHaveBeenCalled(); expect(settled).toHaveBeenCalledWith("session", "", "app: merge", true, true);
  await expect(call()).rejects.toThrow("already received");
});
it("asks once, binds approval to the session, and dispatches only after allow", async () => {
  const pending = call();
  await vi.waitFor(() => expect(notify).toHaveBeenCalled());
  const id = notify.mock.calls[0]![1].approvalId;
  expect(policy.resolve("other", id, true)).toBe(false);
  expect(policy.resolve("session", id, true)).toBe(true);
  await pending;
  expect(policy.resolve("session", id, true)).toBe(false);
});
it("disabled tools are absent and refuse stale direct calls", async () => {
  await policy.catalog("app", "install-1", [write]);
  await policy.update({ [ruleKey("app", "merge")]: { identity: "install-1", mode: "disabled" } });
  expect(await policy.catalog("app", "install-1", [write])).toEqual([]);
  await expect(call()).rejects.toThrow("disabled"); expect(notify).not.toHaveBeenCalled();
});
it("rechecks disabling while an approval is pending", async () => {
  await policy.catalog("app", "install-1", [write]);
  const pending = call(); const refused = expect(pending).rejects.toThrow("disabled");
  await vi.waitFor(() => expect(notify).toHaveBeenCalled());
  await policy.update({ [ruleKey("app", "merge")]: { identity: "install-1", mode: "disabled" } });
  policy.resolve("session", notify.mock.calls[0]![1].approvalId, true); await refused;
});
it("expires, cancels and closes pending requests without dispatch", async () => {
  await expect(call()).rejects.toThrow("expired");
  const abort = new AbortController(); const second = call("2", abort.signal); const refused = expect(second).rejects.toThrow();
  await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(2)); abort.abort(); await refused;
  const third = call("3"); const closed = expect(third).rejects.toThrow();
  await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(3)); policy.close(); await closed;
});
it("refuses stale catalog updates and preserves rules after incomplete discovery", async () => {
  await policy.catalog("app", "install-1", [write]);
  await policy.update({ [ruleKey("app", "merge")]: { identity: "install-1", mode: "run" } });
  await expect(policy.update({ [ruleKey("app", "merge")]: { identity: "old", mode: "disabled" } })).rejects.toThrow("changed");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  try { await expect(policy.discover("app", "install-1", "http://unavailable.test", "token")).rejects.toThrow("preserved"); }
  finally { vi.unstubAllGlobals(); }
  expect(await policy.mode("app", "install-1", "merge")).toBe("run");
});

it("invalidates unprompted authority if its rule or tool changes before forwarding", async () => {
  await policy.update({ [ruleKey("app", "merge")]: { identity: "install-1", mode: "run" } });
  const guard = await call();
  await policy.update({ [ruleKey("app", "merge")]: { identity: "install-1", mode: "ask" } });
  await expect(guard()).rejects.toThrow("changed");
  await policy.update({ [ruleKey("app", "merge")]: { identity: "install-1", mode: "run" } });
  const second = await call("2");
  await policy.catalog("app", "install-1", [{ ...write, description: "Changed behavior" }]);
  await expect(second()).rejects.toThrow("changed");
});
it("rejects malformed rule keys and unknown tools", async () => {
  expect(validRules({ null: { identity: "install-1", mode: "run" } })).toBe(false);
  await policy.catalog("app", "install-1", []);
  await expect(call()).rejects.toThrow("Unknown");
  expect(notify).not.toHaveBeenCalled();
});

it("scopes RPC replay checks to the native client lifetime and invalidates old dispatch guards", async () => {
  await policy.update({ [ruleKey("app", "merge")]: { identity: "install-1", mode: "run" } });
  const old = await call("1");
  await expect(call("1")).rejects.toThrow("already received");
  policy.cancel("session");
  await expect(old()).rejects.toThrow("canceled");
  const current = await call("1");
  await current();
  await expect(call("1")).rejects.toThrow("already received");
});

it("autonomy skips Ask only for the selected session and still rechecks Disabled and revocation", async () => {
  let autonomous = true;
  policy.close();
  policy = new McpToolPolicy(settings, notify, settled, 200, id => autonomous && id === "session");
  await policy.catalog("app", "install-1", [write]);
  const guard = await call();
  expect(notify).not.toHaveBeenCalled();
  autonomous = false;
  await expect(guard()).rejects.toThrow("policy changed");
  autonomous = true;
  await policy.update({ [ruleKey("app", "merge")]: { identity: "install-1", mode: "disabled" } });
  await expect(call("2")).rejects.toThrow("disabled");
  await expect(guard()).rejects.toThrow("policy changed");
  await policy.update({ [ruleKey("app", "merge")]: { identity: "install-1", mode: "ask" } });
  const other = policy.authorize("other", "app", "install-1", "3", "merge", {}, new AbortController().signal);
  await vi.waitFor(() => expect(notify).toHaveBeenCalled());
  policy.cancel("other");
  await expect(other).rejects.toThrow("denied");
});

it("revokes an app without cancelling development approval or clearing its replay guard", async () => {
  await policy.catalog("development", "v1", [write]);
  const app = call().catch(error => error);
  const development = policy.authorize("session", "development", "v1", "1", "merge", {}, new AbortController().signal);
  await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(2));
  policy.cancel("session", "app");
  expect(await app).toBeInstanceOf(Error);
  const id = notify.mock.calls.find(c => c[1].toolName === "development: merge")![1].approvalId;
  expect(policy.resolve("session", id, true)).toBe(true);
  const guard = await development; await guard();
  policy.cancel("session", "app"); await guard();
  await expect(policy.authorize("session", "development", "v1", "1", "merge", {}, new AbortController().signal)).rejects.toThrow("already received");
  policy.cancel("session"); await expect(guard()).rejects.toThrow("canceled");
});

it("applies a provider default to new tools while preserving explicit exceptions and missing tools", async () => {
  await settings.update({ mcpDefaults: { app: { identity: "install-1", mode: "run" } } });
  await policy.update({ [ruleKey("app", "merge")]: { identity: "install-1", mode: "ask" } });
  await policy.catalog("app", "install-1", [write, { name: "new_tool" }]);
  expect(await policy.mode("app", "install-1", "new_tool")).toBe("run");
  expect(await policy.mode("app", "install-1", "merge")).toBe("ask");
  await policy.catalog("app", "install-1", [{ name: "new_tool" }]);
  expect((await settings.read()).mcpToolRules![ruleKey("app", "merge")]).toBeDefined();
  await policy.catalog("app", "install-1", [write, { name: "new_tool" }]);
  expect(await policy.mode("app", "install-1", "merge")).toBe("ask");
});

it("enforces local development exclusions while refusing local app-access exclusions", async () => {
  await policy.catalog("hosty:development", "development-1", [write]);
  const key = ruleKey("hosty:development", "merge");
  const prepared = policy.preparePreferences({ "hosty:development": { identity: "development-1", mode: "run" } },
    { [key]: { identity: "development-1", mode: "disabled" } });
  await settings.update({ mcpDefaults: prepared.defaults, mcpToolRules: prepared.rules });
  await expect(policy.authorize("session", "hosty:development", "development-1", "local-1", "merge", {}, new AbortController().signal)).rejects.toThrow("disabled");
  expect(notify).not.toHaveBeenCalled();
  expect(() => policy.preparePreferences({}, { [ruleKey("app", "merge")]: { identity: "install-1", mode: "disabled" } })).toThrow("Core access review");
});


it.each([false, true])("honors explicit Delete Ask, Run and Disabled with autonomy=%s", async autonomous => {
  policy.close();
  policy = new McpToolPolicy(settings, notify, settled, 1000, () => autonomous);
  const tool = { name: "delete_workspace", annotations: { readOnlyHint: false, destructiveHint: true } };
  await policy.catalog("hosty:development", "v1", [tool]);
  const key = ruleKey("hosty:development", tool.name);
  const invoke = (id: string) => policy.authorize("session", "hosty:development", "v1", id, tool.name, { all: true, requestId: id }, new AbortController().signal);
  await policy.update({ [key]: { identity: "v1", mode: "ask" } });
  const pending = invoke("ask");
  await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
  expect(policy.resolve("session", notify.mock.calls[0]![1].approvalId, true)).toBe(true);
  const approved = await pending; await approved();
  await policy.update({ [key]: { identity: "v1", mode: "run" } });
  const automatic = await invoke("run"); await automatic();
  expect(notify).toHaveBeenCalledOnce();
  await policy.update({ [key]: { identity: "v1", mode: "disabled" } });
  expect(await policy.catalog("hosty:development", "v1", [tool])).toEqual([]);
  await expect(invoke("disabled")).rejects.toThrow("disabled");
  await expect(automatic()).rejects.toThrow("changed");
});
