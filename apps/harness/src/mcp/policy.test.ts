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
  expect(Object.keys((await settings.read()).mcpToolRules!)).toHaveLength(21);
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
