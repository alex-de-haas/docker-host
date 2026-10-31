import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SettingsStore } from "../settings/store.js";
import { McpToolPolicy, ruleKey } from "./policy.js";
import { coreAliases, LEGACY_DEVELOPMENT_PROVIDER as legacy, LEGACY_DEVELOPMENT_IDENTITY as oldIdentity, validCoreMigration } from "./core-migration.js";
const core = "hosty:core", identity = "core-install";
const tool = (name: string) => ({ name, _meta: { "io.hosty/core-tool": { owner: core, schemaVersion: 1 } } });
let dir: string, settings: SettingsStore, policy: McpToolPolicy;
const notify = vi.fn(), settled = vi.fn();
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "hosty-core-migration-"));
  settings = new SettingsStore(dir); notify.mockResolvedValue(undefined); settled.mockResolvedValue(undefined);
  policy = new McpToolPolicy(settings, notify, settled, 1000);
});
afterEach(async () => { policy.close(); vi.resetAllMocks(); await rm(dir, { recursive: true, force: true }); });
it("keeps the reviewed alias inventory explicit and leaves private tools with their provider", () => {
  expect(Object.keys(coreAliases)).toHaveLength(69);
  expect(coreAliases.list).toBe("list_workspaces");
  expect(coreAliases.merge_upstream).toBe("merge_workspace_upstream");
  for (const name of ["task_result", "context_list", "context_search", "context_add", "context_remove"]) expect(coreAliases[name]).toBeUndefined();
});
it("atomically preserves conflicting alias denials and their original records across restarts", async () => {
  await policy.catalog(legacy, oldIdentity, [{ name: "list" }, { name: "workspace_inventory" }]);
  await policy.update({ [ruleKey(legacy, "list")]: { identity: oldIdentity, mode: "run" }, [ruleKey(legacy, "workspace_inventory")]: { identity: oldIdentity, mode: "disabled" } });
  const before = (await settings.read()).mcpToolRules;
  expect(await policy.catalog(core, identity, [tool("list_workspaces")])).toEqual([]);
  for (const alias of ["list", "workspace_inventory"]) expect(await policy.mode(legacy, oldIdentity, alias)).toBe("disabled");
  expect(await policy.mode(core, identity, "list_workspaces")).toBe("disabled");
  const reopened = await new SettingsStore(dir).read();
  expect(validCoreMigration(reopened.mcpCoreMigration)).toBe(true);
  expect(reopened.mcpCoreMigration?.legacyRules.list).toEqual(before?.[ruleKey(legacy, "list")]);
  expect(reopened.mcpToolRules?.[ruleKey(legacy, "workspace_inventory")]).toEqual(before?.[ruleKey(legacy, "workspace_inventory")]);
});
it("asks for new Core grants and unknown tools despite old provider-wide Run defaults", async () => {
  await settings.update({ mcpDefaults: { [legacy]: { identity: oldIdentity, mode: "run" }, [core]: { identity, mode: "run" } } });
  await policy.catalog(core, identity, [tool("environment_start"), tool("get_host_status"), { name: "unknown" }]);
  expect(await policy.mode(core, identity, "environment_start")).toBe("ask");
  expect(await policy.mode(legacy, oldIdentity, "environment_start")).toBe("ask");
  expect(await policy.mode(core, identity, "unknown")).toBe("ask");
  expect(await policy.mode(core, identity, "get_host_status")).toBe("run");
});
it("does not repeatedly restore archived denials after explicit canonical approval", async () => {
  await settings.update({ mcpToolRules: { [ruleKey(legacy, "prepare")]: { identity: oldIdentity, mode: "disabled" } } });
  await policy.catalog(core, identity, [tool("prepare_workspace")]);
  await policy.update({ [ruleKey(core, "prepare_workspace")]: { identity, mode: "run" } });
  await policy.catalog(legacy, oldIdentity, [{ name: "prepare" }]);
  await policy.catalog(core, identity, [tool("prepare_workspace")]);
  expect(await policy.mode(legacy, oldIdentity, "prepare")).toBe("run");
  expect((await settings.read()).mcpCoreMigration?.legacyRules.prepare?.mode).toBe("disabled");
  expect(await policy.catalog(legacy, oldIdentity, [{ name: "prepare" }])).toHaveLength(1);
});
it("does not accept app ownership metadata or an unrecognized Core schema as an alias migration", async () => {
  await policy.catalog("unrelated-provider", identity, [tool("prepare_workspace")]);
  expect((await settings.read()).mcpCoreMigration).toBeUndefined();
  await policy.catalog(core, identity, [{ name: "prepare_workspace", _meta: { "io.hosty/core-tool": { owner: core, schemaVersion: 99 } } }]);
  expect((await settings.read()).mcpCoreMigration?.aliases).toEqual([]);
});
it("keeps disabled aliases unavailable when Core disappears or changes identity", async () => {
  await settings.update({ mcpToolRules: { [ruleKey(legacy, "prepare")]: { identity: oldIdentity, mode: "disabled" } } });
  await policy.catalog(core, identity, [tool("prepare_workspace")]);
  policy.close(); policy = new McpToolPolicy(new SettingsStore(dir), notify, settled);
  expect(await policy.mode(legacy, oldIdentity, "prepare")).toBe("disabled");
  await policy.catalog(core, "replacement", [tool("prepare_workspace")]);
  expect(await policy.mode(legacy, oldIdentity, "prepare")).toBe("disabled");
});
it("enforces canonical Ask in autonomous mode and revocation before legacy dispatch", async () => {
  policy.close(); policy = new McpToolPolicy(settings, notify, settled, 1000, () => true);
  await settings.update({ mcpToolRules: { [ruleKey(legacy, "prepare")]: { identity: oldIdentity, mode: "ask" } } });
  await policy.catalog(legacy, oldIdentity, [{ name: "prepare" }]);
  await policy.catalog(core, identity, [tool("prepare_workspace")]);
  const pending = policy.authorize("session", legacy, oldIdentity, "request", "prepare", {}, new AbortController().signal);
  const denied = expect(pending).rejects.toThrow("disabled");
  await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
  await policy.update({ [ruleKey(core, "prepare_workspace")]: { identity, mode: "disabled" } });
  policy.resolve("session", notify.mock.calls[0]![1].approvalId, true);
  await denied;
});
it("does not replay migration when concurrent catalogs or unrelated provider markers arrive", async () => {
  await Promise.all([policy.catalog(core, identity, [tool("prepare_workspace")]), policy.catalog(legacy, oldIdentity, [{ name: "prepare" }])]);
  await policy.update({ [ruleKey(core, "prepare_workspace")]: { identity, mode: "run" } });
  await settings.update({ mcpPolicyMigrated: [] });
  await policy.catalog(core, identity, [tool("prepare_workspace"), tool("history_get")]);
  expect(await policy.mode(legacy, oldIdentity, "prepare")).toBe("run");
  expect(await policy.mode(core, identity, "history_get")).toBe("ask");
  expect((await settings.read()).mcpCoreMigration?.aliases.filter(a => a === "prepare")).toHaveLength(1);
});

it("invalidates an already approved alias if the canonical definition changes", async () => {
  await policy.catalog(legacy, oldIdentity, [{ name: "prepare" }]);
  await policy.catalog(core, identity, [tool("prepare_workspace")]);
  const pending = policy.authorize("session", legacy, oldIdentity, "request", "prepare", {}, new AbortController().signal);
  await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
  policy.resolve("session", notify.mock.calls[0]![1].approvalId, true);
  const guard = await pending;
  await policy.catalog(core, identity, [{ ...tool("prepare_workspace"), description: "Changed resource scope" }]);
  await expect(guard()).rejects.toThrow("policy changed");
});

it("binds private tools to the actual installation and retains their pre-migration rules", async () => {
  await policy.catalog(legacy, oldIdentity, [{ name: "context_add" }, { name: "task_result" }]);
  await policy.update({ [ruleKey(legacy, "context_add")]: { identity: oldIdentity, mode: "run" }, [ruleKey(legacy, "task_result")]: { identity: oldIdentity, mode: "disabled" } });
  await policy.catalog(core, identity, [tool("prepare_workspace")]);
  policy.localOwner = { appId: "unrelated.runner", displayName: "Independent assistant", installationId: "first" };
  const tools = [{ name: "context_add" }, { name: "task_result" }, { name: "prepare" }];
  expect((await policy.localCatalog(tools)).map(t => t.name)).toEqual(["context_add"]);
  const firstIdentity = policy.localIdentity;
  expect(await policy.mode(legacy, firstIdentity, "context_add")).toBe("ask");
  expect((await settings.read()).mcpCoreMigration?.legacyRules.context_add?.mode).toBe("run");
  await policy.update({ [ruleKey(legacy, "context_add")]: { identity: firstIdentity, mode: "run" } });
  policy.localOwner = { ...policy.localOwner, installationId: "replacement" };
  await policy.localCatalog(tools);
  expect(await policy.mode(legacy, policy.localIdentity, "context_add")).toBe("ask");
  expect(await policy.mode(legacy, policy.localIdentity, "task_result")).toBe("disabled");
  expect(policy.snapshot().find(c => c.provider === legacy)?.tools.map(t => t.name)).toEqual(["context_add", "task_result"]);
  expect(validCoreMigration((await new SettingsStore(dir).read()).mcpCoreMigration)).toBe(true);
});
