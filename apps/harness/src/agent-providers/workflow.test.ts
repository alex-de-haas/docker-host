import { CHAT_WORKFLOW_PROVIDER } from "../../shared/chat-workflow.js";
import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { AGENT_CAPABILITIES, AGENT_SUBAGENT_WORKFLOW_TOOLS, AGENT_SESSION_WORKFLOW_TOOLS, type AgentSessionWorkflowRequest } from "@hosty-sdk/app/agent";
import { ProviderClient } from "@hosty-sdk/app/providers/server";
import { ProviderError, type MediatedProviderInvocation } from "@hosty-sdk/app/providers";
import { validateAgentMcpSelection } from "@hosty-sdk/app/agent/server";
import { SettingsStore } from "../settings/store.js";
import { ProfileStore } from "../profiles/store.js";
import { ProviderDirectory, CORE_PROVIDER_ID, type McpProvider } from "../settings/providers.js";
import { TASK_ORCHESTRATION_GUIDE, taskTools } from "../tasks/tools.js";
import { publicProviderFixture, type PublicProviderFixture } from "./test-fixture.js";

const fixtures: PublicProviderFixture[] = [];
const consumer = { appId: "unrelated.consumer", installationId: "consumer-installation", key: "default" };
afterEach(async () => {
  for (const fixture of fixtures.splice(0).reverse()) await fixture.close();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});
async function fixture(options: { enabled?: boolean; offered?: boolean; available?: boolean; permission?: boolean; subagents?: boolean; legacyWorkflowCore?: boolean; installationHistory?: boolean } = {}) {
  vi.stubEnv("HOSTY_APP_ID", consumer.appId); vi.stubEnv("HOSTY_APP_INSTALLATION_ID", consumer.installationId);
  vi.stubEnv("HOSTY_CORE_ORIGIN", undefined); vi.stubEnv("HOSTY_APP_SERVICE_TOKEN", "fixture-service");
  vi.spyOn(ProviderClient.prototype, "permissions").mockResolvedValue({ required: [], optional: ["providers.task-executor"],
    granted: options.permission === false ? [] : ["providers.task-executor"] });
  const f = await publicProviderFixture(options.installationHistory); fixtures.push(f);
  f.behavior.legacyWorkflowCore = options.legacyWorkflowCore;
  const settings = new SettingsStore(path.join(f.root, "workflow-settings"));
  await settings.update({ mcpProviders: { [CORE_PROVIDER_ID]: options.enabled !== false } });
  const initialSettings = structuredClone(await settings.read());
  const providers = new ProviderDirectory(null, null, consumer.appId);
  const core: McpProvider = { appId: CORE_PROVIDER_ID, displayName: "Core", offered: options.offered !== false, running: true,
    policyIdentity: "reviewed-core-policy", url: "http://core.test/api/mcp", interfaces: [{ key: "default", url: "http://core.test/api/mcp" }] };
  vi.spyOn(providers, "read").mockResolvedValue(options.available === false ? null : { providers: [], installedAppIds: [], revision: "reviewed-directory" });
  vi.spyOn(providers, "core").mockReturnValue(core); vi.spyOn(providers, "readApps").mockResolvedValue([]);
  const profiles = options.subagents ? new ProfileStore(path.join(f.root, "family-profiles"), async () => ({
    name: "Reviewer", description: "", instructions: "", model: null, connectionId: f.connectionId, reasoningEffort: null, skillIds: [],
  })) : undefined;
  if (profiles) f.capabilities.capabilities.push(AGENT_CAPABILITIES.sessionSubagents);
  const { manager, store } = f.makeManager({ settings, providers, profiles });
  const taskAction = vi.fn(async () => ({ recorded: true })); manager.taskAction = taskAction;
  return { f, manager, store, settings, initialSettings, providers, profiles, taskAction };
}
async function admitted(options: Parameters<typeof fixture>[0] = {}) {
  const value = await fixture(options), { f, manager, store } = value;
  const record = await manager.createSession({ createdBy: f.owner });
  await manager.postMessage(record.id, "Use the explicitly available workflow", f.credential, [], { actorUserId: f.owner, clientRequestId: randomUUID() });
  const state = (await store.readProviderExecution(record.id))!;
  const agent = { provider: f.provider, sessionId: state.sessionId, runId: state.runId! };
  const input: AgentSessionWorkflowRequest = { action: "task-execution-get", input: {}, agent };
  const invocation: MediatedProviderInvocation = { version: 2, kind: "task-executor", key: "default", operation: "session.workflow",
    callerAppId: f.provider.appId, callerInstallation: f.provider.installationId, userId: f.owner, hostRole: "host.admin", principalId: "original-principal",
    resourceIds: [], agentExecution: structuredClone(agent) };
  return { ...value, record, state, input, invocation };
}

it.each([
  { enabled: false }, { offered: false }, { available: false },
])("admits the separate business workflow without changing unavailable or disabled general Core MCP (%j)", async options => {
  const { f, state, record, settings, initialSettings } = await admitted(options);
  const start = f.authorizations.find(request => request.operation === "runs.start")!;
  expect(start.ceiling?.workflow).toMatchObject({ executor: consumer, sessionId: record.id,
    tools: [...AGENT_SESSION_WORKFLOW_TOOLS], policy: { default: "ask" } });
  expect(state.lastRunInput?.workflow).toEqual(start.ceiling!.workflow);
  expect(f.starts[0]!.input.mcp?.targets).toEqual([]);
  expect(await settings.read()).toEqual(initialSettings);
  expect(f.sessions.get(state.sessionId)!.configuration!.instructions?.map(block => block.text).join("\n")).toContain(TASK_ORCHESTRATION_GUIDE);
  expect(f.starts).toHaveLength(1);
});

it.each([false, true])("negotiates ordinary child chats independently of the task grant (%s)", async permission => {
  const { f, manager, state, record, input, invocation, taskAction } = await admitted({ subagents: true, permission });
  const binding = state.lastRunInput!.workflow!;
  expect(binding.tools).toEqual([...(permission ? AGENT_SESSION_WORKFLOW_TOOLS : []), ...AGENT_SUBAGENT_WORKFLOW_TOOLS]);
  expect(state.lastRunInput!.input.requiredCapabilities).toEqual([...(permission ? [AGENT_CAPABILITIES.consumerWorkflow] : []), AGENT_CAPABILITIES.sessionSubagents]);
  expect(f.sessions.get(state.sessionId)!.configuration!.instructions?.map(block => block.text).join(" ")).toContain("subagent_spawn");
  const call = { ...input, action: "subagent-profiles" }, actor = { ...invocation, kind: "agent-sessions" as const };
  expect(await manager.providerWorkflow(record.id, call, actor, async () => actor)).toMatchObject({ profiles: [{ name: "Reviewer" }] });
  await expect(manager.providerWorkflow(record.id, call, invocation, async () => invocation)).rejects.toMatchObject({ code: "workflow_binding_mismatch" });
  await expect(manager.providerWorkflow(record.id, call, actor, async () => ({ ...actor, userId: "another-user" }))).rejects.toMatchObject({ code: "workflow_binding_mismatch" });
  expect(taskAction).not.toHaveBeenCalled();
});

it.each([false, true])("keeps ordinary turns available on an older Core with task permission %s", async permission => {
  const { f, state } = await admitted({ subagents: true, legacyWorkflowCore: true, permission });
  const authorization = f.authorizations.find(request => request.operation === "runs.start")!;
  const expectedTools = permission ? [...AGENT_SESSION_WORKFLOW_TOOLS] : undefined;
  expect(authorization.ceiling?.workflow?.tools).toEqual(expectedTools);
  expect(state.lastRunInput?.workflow?.tools).toEqual(expectedTools);
  expect(f.starts).toHaveLength(1);
  expect(f.starts[0]!.input.requiredCapabilities ?? []).toEqual(permission ? [AGENT_CAPABILITIES.consumerWorkflow] : []);
  const instructions = f.sessions.get(state.sessionId)!.configuration!.instructions?.map(block => block.text).join(" ") ?? "";
  expect(instructions).not.toContain("subagent_spawn");
});

it("uses a provider's child-only workflow even when Harness also holds the task permission", async () => {
  const { f, manager, store } = await fixture({ subagents: true, permission: true });
  f.capabilities.capabilities = f.capabilities.capabilities.filter(capability => capability !== AGENT_CAPABILITIES.consumerWorkflow);
  const record = await manager.createSession({ createdBy: f.owner });
  await manager.postMessage(record.id, "Delegate from this chat", f.credential, [], { actorUserId: f.owner, clientRequestId: randomUUID() });
  const input = (await store.readProviderExecution(record.id))!.lastRunInput!;
  expect(input.workflow?.tools).toEqual([...AGENT_SUBAGENT_WORKFLOW_TOOLS]);
  expect(input.input.requiredCapabilities).toEqual([AGENT_CAPABILITIES.sessionSubagents]);
  expect(f.sessions.get(f.starts[0]!.sessionId)!.configuration!.instructions?.map(block => block.text).join(" ")).not.toContain(TASK_ORCHESTRATION_GUIDE);
});

it("pins discovered private tool preferences to the next child-chat binding without enabling another MCP target", async () => {
  const { f, manager, settings } = await fixture({ subagents: true, permission: false, enabled: false });
  const scope = CHAT_WORKFLOW_PROVIDER;
  await manager.discoverMcpTools(f.credential);
  const catalog = manager.mcpPolicy.snapshot().find(entry => entry.provider === scope)!;
  expect(catalog.tools.map(tool => tool.name)).toEqual([...AGENT_SUBAGENT_WORKFLOW_TOOLS]);
  expect(manager.mcpPolicy.snapshot().filter(entry => entry.provider !== scope)
    .some(entry => entry.tools.some(tool => tool.name === "subagent_spawn"))).toBe(false);
  const key = (tool: string) => JSON.stringify([scope, tool]);
  const { rules } = manager.mcpPolicy.preparePreferences({}, {
    [key("subagent_spawn")]: { identity: catalog.identity, mode: "ask" },
    [key("subagent_wait")]: { identity: catalog.identity, mode: "disabled" },
    [key("subagent_status")]: { identity: catalog.identity, mode: "run" },
  });
  expect(rules[key("subagent_status")]?.definition).toMatch(/^[a-f0-9]{64}$/);
  expect(() => manager.mcpPolicy.preparePreferences({ [scope]: { identity: catalog.identity, mode: "run" } }, {})).toThrow();
  expect(() => manager.mcpPolicy.preparePreferences({}, { [key("subagent_status")]: { identity: "another-installation", mode: "run" } })).toThrow();
  expect(() => manager.mcpPolicy.preparePreferences({}, { [key("task_create")]: { identity: catalog.identity, mode: "run" } })).toThrow();
  await settings.transform(current => ({ mcpToolRules: { ...current.mcpToolRules, ...rules } }));
  const record = await manager.createSession({ createdBy: f.owner });
  await manager.postMessage(record.id, "Use the saved child-chat policy", f.credential, [], { actorUserId: f.owner, clientRequestId: randomUUID() });
  const workflow = f.authorizations.find(request => request.operation === "runs.start")!.ceiling!.workflow!;
  expect(workflow.tools).toEqual([...AGENT_SUBAGENT_WORKFLOW_TOOLS]);
  expect(workflow.policy).toEqual({ default: "ask", tools: {
    subagent_spawn: { mode: "ask" }, subagent_wait: { mode: "disabled" },
    subagent_status: { mode: "run", definition: rules[key("subagent_status")]!.definition },
  } });
  expect(f.starts[0]!.input.mcp?.targets).toEqual([]);
});

it.each([false, true])("recovers the original child admission after temporarily unavailable preflight (restart %s)", async restart => {
  const { f, manager, store, settings, providers, profiles } = await fixture({ subagents: true, permission: false });
  const parent = await manager.createSession({ createdBy: f.owner });
  await manager.refreshSessionCredentials(parent.id, f.owner, f.credential);
  const profile = (await profiles!.read()).profiles[0]!;
  f.behavior.failSessionLookup = true;
  const child = await manager.subagentAction(parent.id, "subagent-spawn", {
    requestId: randomUUID(), profileId: profile.id, profileRevision: profile.revision, prompt: "Review after provider recovery.",
  }, async () => {}) as { childSessionId: string };
  const childId = child.childSessionId;
  await vi.waitFor(async () => expect((await store.readSessionFamily(parent.id)).launches[0]?.child.status).toBe("unknown"));
  const runId = (await store.readSessionFamily(parent.id)).launches[0]!.runId;
  expect(f.starts).toHaveLength(0);
  expect(await store.readMessageReceipt(childId, runId)).toMatchObject({ state: "unknown" });
  let active = manager;
  if (restart) {
    await manager.shutdown();
    active = f.makeManager({ settings, providers, profiles }).manager;
    await active.recoverSubagents();
  }
  f.behavior.failSessionLookup = false;
  if (restart) await active.refreshActorCredentials(f.owner, f.credential);
  await vi.waitFor(async () => expect(await store.readMessageReceipt(childId, runId)).toMatchObject({ state: "accepted" }), { timeout: 5000 });
  expect(f.starts.map(start => start.runId)).toEqual([runId]);
  expect((await store.readEvents(childId)).filter(event => event.type === "subagent_assignment")).toHaveLength(1);
  f.complete(runId, "Checked");
  await vi.waitFor(async () => expect((await store.readSessionFamily(parent.id)).launches[0]!.child).toMatchObject({ status: "completed", result: "Checked" }));
});

it("reconciles a lost child start response and retries its parent's original preflight without repeating either input", async () => {
  const { f, record: parent, manager, store, profiles } = await admitted({ subagents: true, permission: false });
  const profile = (await profiles!.read()).profiles[0]!;
  f.behavior.loseNextStartResponse = true;
  const { childSessionId } = await manager.subagentAction(parent.id, "subagent-spawn", {
    requestId: randomUUID(), profileId: profile.id, profileRevision: profile.revision, prompt: "Return a review.",
  }, async () => {}) as { childSessionId: string };
  const { runId } = (await store.readSessionFamily(parent.id)).launches[0]!;
  await vi.waitFor(async () => expect(await store.readMessageReceipt(childSessionId, runId)).toMatchObject({ state: "accepted" }), { timeout: 5000 });
  const submissions = f.requests.filter(request => request.method === "PUT" && request.path.endsWith("/runs/" + runId));
  expect(submissions).toHaveLength(2);
  expect(submissions[0]!.body).toBe(submissions[1]!.body);
  const ticket = await manager.subagentAction(parent.id, "subagent-wait", {
    requestId: randomUUID(), childSessionIds: [childSessionId], mode: "all",
  }, async () => {});
  expect(ticket).toMatchObject({ state: "pending" });
  f.complete(f.starts[0]!.runId, "Waiting for review");
  await vi.waitFor(async () => expect((await manager.getSession(parent.id))?.status).toBe("idle"));
  const previousRequests = f.requests.length;
  f.behavior.failSessionLookup = true;
  f.complete(runId, "Reviewed");
  const wakeId = (await store.readSessionFamily(parent.id)).waits[0]!.runId;
  await vi.waitFor(() => expect(f.requests.slice(previousRequests).some(request => request.method === "GET"
    && request.path.endsWith("/sessions/" + f.starts[0]!.sessionId))).toBe(true), { timeout: 5000 });
  expect(await store.readMessageReceipt(parent.id, wakeId)).toMatchObject({ state: "unknown" });
  f.behavior.failSessionLookup = false;
  await vi.waitFor(async () => expect((await store.readSessionFamily(parent.id)).waits[0]!.state).toBe("delivered"), { timeout: 5000 });
  expect(f.starts.map(start => start.runId)).toEqual([f.starts[0]!.runId, runId, wakeId]);
  expect((await store.readEvents(parent.id)).filter(event => event.type === "subagent_continuation")).toHaveLength(1);
  expect((await store.readEvents(childSessionId)).filter(event => event.type === "subagent_assignment")).toHaveLength(1);
}, 15000);

it.each([false, true])("delivers a ready child result only after confirmed parent failure and honors explicit Stop (%s)", async stopped => {
  const { f, record: parent, state, manager, store, profiles } = await admitted({ subagents: true, permission: false, installationHistory: true });
  const profile = (await profiles!.read()).profiles[0]!;
  const { childSessionId } = await manager.subagentAction(parent.id, "subagent-spawn", {
    requestId: randomUUID(), profileId: profile.id, profileRevision: profile.revision, prompt: "Complete the delegated review.",
  }, async () => {}) as { childSessionId: string };
  const childRunId = (await store.readSessionFamily(parent.id)).launches[0]!.runId;
  await vi.waitFor(async () => expect(await store.readMessageReceipt(childSessionId, childRunId)).toMatchObject({ state: "accepted" }), { timeout: 5000 });
  const ticket = { requestId: randomUUID(), childSessionIds: [childSessionId], mode: "all" };
  expect(await manager.subagentAction(parent.id, "subagent-wait", ticket, async () => {})).toMatchObject({ state: "pending" });
  f.update(state.runId!, { state: "unknown", phase: "interrupted", freshness: "last_known", stopConfirmed: false });
  await vi.waitFor(async () => expect((await store.readRecord(parent.id))!.status).toBe("failed"), { timeout: 5000 });
  f.complete(childRunId, "Review complete");
  const wait = async () => (await store.readSessionFamily(parent.id)).waits[0]!;
  await vi.waitFor(async () => expect((await wait()).state).toBe("ready"), { timeout: 5000 });
  const wakeId = (await wait()).runId;
  expect(await store.readMessageReceipt(parent.id, wakeId)).toBeNull();
  expect(f.starts).toHaveLength(2);
  if (stopped) await manager.cancelSession(parent.id);
  f.update(state.runId!, { state: "failed", phase: "terminal", stopConfirmed: true, freshness: "current",
    result: { status: "failed", error: { code: "provider_failed", message: "The parent failed.", retryable: false } } });
  await vi.waitFor(async () => expect((await wait()).state).toBe(stopped ? "cancelled" : "delivered"), { timeout: 5000 });
  await manager.recoverSubagents();
  expect(await manager.subagentAction(parent.id, "subagent-wait", ticket, async () => {})).toMatchObject({ state: stopped ? "cancelled" : "delivered" });
  expect(f.starts.filter(start => start.runId === wakeId)).toHaveLength(stopped ? 0 : 1);
  expect((await store.readEvents(parent.id)).filter(event => event.type === "subagent_continuation")).toHaveLength(stopped ? 0 : 1);
}, 15000);

it("keeps ordinary chat available without a workflow when its task-executor permission is absent", async () => {
  const { f, state, settings, initialSettings } = await admitted({ enabled: false, permission: false });
  const start = f.authorizations.find(request => request.operation === "runs.start")!;
  expect(start.ceiling?.workflow).toBeUndefined(); expect(state.lastRunInput?.workflow).toBeUndefined();
  expect(f.sessions.get(state.sessionId)!.configuration!.instructions?.map(block => block.text).join("\n")).not.toContain(TASK_ORCHESTRATION_GUIDE);
  expect(f.starts[0]!.input.mcp?.targets).toEqual([]); expect(await settings.read()).toEqual(initialSettings);
  expect(f.starts).toHaveLength(1);
});

it("rejects a task-bound send before public provider admission when its task-executor permission is absent", async () => {
  const { f, manager } = await fixture({ permission: false }), executionId = randomUUID();
  const record = await manager.createSession({ createdBy: f.owner, taskExecutionId: executionId });
  await expect(manager.postMessage(record.id, "Run the admitted task", f.credential, [], { actorUserId: f.owner, clientRequestId: executionId, taskDispatch: true }))
    .rejects.toMatchObject({ code: "task_workflow_setup_required" });
  expect(f.starts).toEqual([]); expect(f.sessions.size).toBe(0);
  expect(f.authorizations.some(request => request.operation === "runs.start" || request.operation === "sessions.create")).toBe(false);
});

it.each([CORE_PROVIDER_ID, "hosty:development"])("rejects a task-bound send before provider admission when %s explicitly disables its required task_result tool", async namespace => {
  const { f, manager, settings } = await fixture({ enabled: false }), executionId = randomUUID();
  await settings.update({ mcpToolRules: { [JSON.stringify([namespace, "task_result"])]: { identity: "previous-policy", mode: "disabled" } } });
  const record = await manager.createSession({ createdBy: f.owner, taskExecutionId: executionId });
  await expect(manager.postMessage(record.id, "Run the admitted task", f.credential, [], { actorUserId: f.owner, clientRequestId: executionId, taskDispatch: true }))
    .rejects.toMatchObject({ code: "task_workflow_setup_required" });
  expect(f.starts).toEqual([]); expect(f.sessions.size).toBe(0);
  expect(f.authorizations.some(request => request.operation === "runs.start" || request.operation === "sessions.create")).toBe(false);
  expect((await settings.read()).mcpProviders[CORE_PROVIDER_ID]).toBe(false);
});

it.each([{ enabled: false }, { offered: false }, { available: false }])("admits a task-bound business workflow independently of general Core MCP (%j)", async options => {
  const { f, manager, settings, initialSettings } = await fixture(options), executionId = randomUUID();
  const record = await manager.createSession({ createdBy: f.owner, taskExecutionId: executionId });
  await manager.postMessage(record.id, "Run the admitted task", f.credential, [], { actorUserId: f.owner, clientRequestId: executionId, taskDispatch: true });
  expect(f.starts).toHaveLength(1); expect(f.starts[0]!.input.mcp?.targets).toEqual([]);
  expect(f.authorizations.find(request => request.operation === "runs.start")!.ceiling?.workflow).toMatchObject({ executor: consumer, sessionId: record.id });
  expect(await settings.read()).toEqual(initialSettings);
});

it("binds the optional workflow ceiling to the current consumer installation and logical/public session mapping", async () => {
  const { f, record, state } = await admitted(), expected = { executor: consumer, sessionId: record.id,
    tools: [...AGENT_SESSION_WORKFLOW_TOOLS], policy: { default: "ask" } };
  const start = f.authorizations.find(request => request.operation === "runs.start")!;
  expect(start.ceiling?.workflow).toMatchObject(expected);
  expect(start).toMatchObject({ sessionId: state.sessionId, runId: state.runId });
  expect(state.lastRunInput).toMatchObject({ runId: state.runId, workflow: expected });
  expect(f.starts[0]!.input.requiredCapabilities).toEqual([AGENT_CAPABILITIES.consumerWorkflow]);
  expect(state.lastRunInput?.input.requiredCapabilities).toEqual([AGENT_CAPABILITIES.consumerWorkflow]);
  expect(JSON.parse(f.starts[0]!.body).requiredCapabilities).toEqual([AGENT_CAPABILITIES.consumerWorkflow]);
  expect(state.sessionId).not.toBe(record.id);
  expect(f.starts[0]!.input.mcp?.targets).toMatchObject([{ target: { kind: "core" } }]);
  expect(f.sessions.get(state.sessionId)!.configuration!.instructions?.map(block => block.text).join("\n")).toContain(TASK_ORCHESTRATION_GUIDE);
  expect(JSON.parse(f.starts[0]!.body).workflow).toBeUndefined();
});

it("rejects a fresh workflow execution before creating a public session when the provider lacks explicit support", async () => {
  const { f, manager, store } = await fixture({ enabled: false });
  f.capabilities.capabilities = f.capabilities.capabilities.filter(value => value !== AGENT_CAPABILITIES.consumerWorkflow);
  const record = await manager.createSession({ createdBy: f.owner });
  await expect(manager.postMessage(record.id, "Require the declared consumer workflow", f.credential, [], { actorUserId: f.owner, clientRequestId: randomUUID() }))
    .rejects.toMatchObject({ code: "workflow_provider_unsupported", status: 422 });
  expect(f.sessions.size).toBe(0); expect(f.starts).toEqual([]);
  expect(f.authorizations.some(request => request.operation === "sessions.create" || request.operation === "runs.start")).toBe(false);
  await vi.waitFor(async () => expect((await store.readEvents(record.id)).some(event => event.type === "notice"
    && typeof event.message === "string" && event.message.includes("does not support consumer task workflows"))).toBe(true));
  await manager.sessionRetention(record.id); // Wait for the notice's record commit through the conversation lane.
});

it("checks fresh workflow support again before configuring or starting another turn in the same public session", async () => {
  const { f, manager, store, record, state } = await admitted({ enabled: false });
  f.complete(state.runId!);
  await vi.waitFor(async () => expect((await store.readRecord(record.id))!.status).toBe("idle"));
  await manager.setAutonomy(record.id, "autonomous", f.owner);
  f.capabilities.capabilities = f.capabilities.capabilities.filter(value => value !== AGENT_CAPABILITIES.consumerWorkflow);
  const before = f.requests.length;
  await expect(manager.postMessage(record.id, "Continue with changed approval settings", f.credential, [], { actorUserId: f.owner, clientRequestId: randomUUID() }))
    .rejects.toMatchObject({ code: "workflow_provider_unsupported", status: 422 });
  expect(f.starts).toHaveLength(1); expect(f.sessions.size).toBe(1);
  expect(f.requests.slice(before).some(request => request.path.includes("/configurations/") || request.method === "PUT" && /\/sessions\/[^/]+$/.test(request.path))).toBe(false);
  expect((await store.readProviderExecution(record.id))!).toMatchObject({ sessionId: state.sessionId, runId: state.runId,
    lastRunInput: { runId: state.runId } });
  await vi.waitFor(async () => expect((await store.readEvents(record.id)).some(event => event.type === "notice"
    && typeof event.message === "string" && event.message.includes("does not support consumer task workflows"))).toBe(true));
  await manager.sessionRetention(record.id); // The event append precedes its durable record update.
});

it("keeps ordinary turns and native-session resume available on an older provider when no consumer workflow is requested", async () => {
  const { f, manager, store } = await fixture({ enabled: false, permission: false });
  f.capabilities.capabilities = f.capabilities.capabilities.filter(value => value !== AGENT_CAPABILITIES.consumerWorkflow);
  const record = await manager.createSession({ createdBy: f.owner });
  await manager.postMessage(record.id, "An ordinary first turn", f.credential, [], { actorUserId: f.owner, clientRequestId: randomUUID() });
  const first = f.starts[0]!;
  f.complete(first.runId);
  await vi.waitFor(async () => expect((await store.readRecord(record.id))!.status).toBe("idle"));
  await manager.postMessage(record.id, "Continue ordinary chat", f.credential, [], { actorUserId: f.owner, clientRequestId: randomUUID() });
  expect(f.starts).toHaveLength(2); expect(f.starts[1]!).toMatchObject({ sessionId: first.sessionId, input: { continuation: "resume" } });
  expect(f.starts.every(start => !start.input.requiredCapabilities?.includes(AGENT_CAPABILITIES.consumerWorkflow))).toBe(true);
  expect(f.authorizations.filter(request => request.operation === "runs.start").every(request => !request.ceiling?.workflow)).toBe(true);
});

it("preserves explicit task-tool denials with Core MCP off without inheriting unrelated tools or general auto-allow", async () => {
  const { f, manager, settings } = await fixture({ enabled: false });
  await settings.update({ mcpDefaults: { [CORE_PROVIDER_ID]: { identity: "reviewed-core-policy", mode: "run" } },
    mcpAutoAllow: { [CORE_PROVIDER_ID]: true }, mcpToolRules: {
      [JSON.stringify([CORE_PROVIDER_ID, "task_result"])]: { identity: "old-core-policy", mode: "disabled" },
      [JSON.stringify([CORE_PROVIDER_ID, "task_wait"])]: { identity: "old-core-policy", mode: "run", definition: "stale-definition" },
      [JSON.stringify([CORE_PROVIDER_ID, "task_get"])]: { identity: "reviewed-core-policy", mode: "run", definition: "reviewed-definition" },
      [JSON.stringify([CORE_PROVIDER_ID, "list_apps"])]: { identity: "reviewed-core-policy", mode: "disabled" },
      [JSON.stringify(["hosty:development", "task_result"])]: { identity: manager.mcpPolicy.localIdentity, mode: "run", definition: "current-local-result" },
      [JSON.stringify(["hosty:development", "task_get"])]: { identity: "previous-local-policy", mode: "disabled" },
      [JSON.stringify(["hosty:development", "task_wait"])]: { identity: manager.mcpPolicy.localIdentity, mode: "run", definition: "current-local-wait" },
      [JSON.stringify(["hosty:development", "task_fail"])]: { identity: "previous-local-policy", mode: "disabled" },
      [JSON.stringify(["hosty:development", "task_execution_get"])]: { identity: manager.mcpPolicy.localIdentity, mode: "run", definition: "current-local-read" },
      [JSON.stringify(["hosty:development", "task_adopt"])]: { identity: "previous-local-policy", mode: "run", definition: "stale-local-definition" },
      [JSON.stringify(["hosty:development", "environment_list"])]: { identity: manager.mcpPolicy.localIdentity, mode: "disabled" },
      [JSON.stringify(["another-mcp-target", "task_result"])]: { identity: "other-policy", mode: "disabled" },
    } });
  const before = structuredClone(await settings.read()), record = await manager.createSession({ createdBy: f.owner });
  await manager.postMessage(record.id, "Use the scoped workflow policy", f.credential, [], { actorUserId: f.owner, clientRequestId: randomUUID() });
  const workflow = f.authorizations.find(request => request.operation === "runs.start")!.ceiling!.workflow!;
  expect(workflow.tools).toEqual([...AGENT_SESSION_WORKFLOW_TOOLS]);
  expect(workflow.policy).toEqual({ default: "ask", tools: {
    task_result: { mode: "disabled" }, task_wait: { mode: "ask" }, task_get: { mode: "disabled" }, task_fail: { mode: "disabled" },
    task_execution_get: { mode: "run", definition: "current-local-read" }, task_adopt: { mode: "ask" },
  } });
  expect(f.starts[0]!.input.mcp?.targets).toEqual([]); expect(await settings.read()).toEqual(before);
});

it.each([false, true])("serializes a new task attempt after catalog observation with only automatic rule digests (general Core MCP %s)", async enabled => {
  const { f, manager, settings, store } = await fixture({ enabled });
  const local = "hosty:development", localIdentity = manager.mcpPolicy.localIdentity, coreIdentity = "reviewed-core-policy";
  const key = (namespace: string, name: string) => JSON.stringify([namespace, name]);
  await settings.update({ mcpToolRules: {
    [key(local, "task_result")]: { identity: localIdentity, mode: "ask" },
    [key(local, "task_fail")]: { identity: localIdentity, mode: "disabled" },
    [key(local, "task_adopt")]: { identity: "previous-tool-catalog", mode: "run", definition: "0".repeat(64) },
    [key(local, "task_execution_get")]: { identity: localIdentity, mode: "ask" },
    [key(CORE_PROVIDER_ID, "task_get")]: { identity: coreIdentity, mode: "ask" },
    [key(CORE_PROVIDER_ID, "task_list")]: { identity: coreIdentity, mode: "disabled" },
  } });
  const startAttempt = async () => {
    const executionId = randomUUID(), record = await manager.createSession({ createdBy: f.owner, taskExecutionId: executionId });
    const acceptance = await manager.postMessage(record.id, "Complete this task through its discovered workflow schema", f.credential, [],
      { actorUserId: f.owner, clientRequestId: executionId, taskDispatch: true }).catch(error => error as Error);
    if (acceptance instanceof Error) {
      await vi.waitFor(async () => expect((await store.readEvents(record.id)).some(event => event.type === "notice")).toBe(true));
      await manager.sessionRetention(record.id);
    }
    expect(acceptance).toMatchObject({ state: "accepted" });
    return record;
  };
  const first = await startAttempt(), originalWorkflow = structuredClone(f.authorizations.find(request => request.operation === "runs.start")!.ceiling!.workflow);
  expect(originalWorkflow?.policy?.tools?.task_result).toEqual({ mode: "ask" });
  expect(originalWorkflow?.policy?.tools?.task_fail).toEqual({ mode: "disabled" });
  expect(() => validateAgentMcpSelection({ targets: [{ target: { kind: "core" }, policy: originalWorkflow?.policy }] })).not.toThrow();
  f.complete(f.starts[0]!.runId);
  await vi.waitFor(async () => expect((await store.readRecord(first.id))!.status).toBe("idle"));
  await manager.sessionRetention(first.id);

  // Catalog observation intentionally retains definition hashes for the preference editor,
  // including Ask/Disabled and a changed automatic rule that now requires Ask again.
  const catalog = taskTools();
  await manager.mcpPolicy.localCatalog(catalog);
  await manager.mcpPolicy.catalog(CORE_PROVIDER_ID, coreIdentity, catalog.filter(tool => ["task_get", "task_list"].includes(tool.name)));
  await settings.transform(current => ({ mcpToolRules: { ...current.mcpToolRules,
    [key(local, "task_execution_get")]: { ...current.mcpToolRules![key(local, "task_execution_get")]!, mode: "run" },
  } }));
  const observed = structuredClone(await settings.read());
  for (const [namespace, name, mode] of [[local, "task_result", "ask"], [local, "task_fail", "disabled"], [local, "task_adopt", "ask"],
    [CORE_PROVIDER_ID, "task_get", "ask"], [CORE_PROVIDER_ID, "task_list", "disabled"]])
    expect(observed.mcpToolRules?.[key(namespace!, name!)]).toMatchObject({ mode, definition: expect.stringMatching(/^[a-f0-9]{64}$/) });
  const automaticDigest = observed.mcpToolRules![key(local, "task_execution_get")]!.definition!;

  const retry = await startAttempt();
  expect(retry.id).not.toBe(first.id); expect(f.starts).toHaveLength(2);
  const policy = f.authorizations.filter(request => request.operation === "runs.start")[1]!.ceiling!.workflow!.policy!;
  expect(() => validateAgentMcpSelection({ targets: [{ target: { kind: "core" }, policy }] })).not.toThrow();
  expect(policy.tools).toEqual({
    task_result: { mode: "ask" }, task_fail: { mode: "disabled" }, task_adopt: { mode: "ask" },
    task_execution_get: { mode: "run", definition: automaticDigest }, task_get: { mode: "ask" }, task_list: { mode: "disabled" },
  });
  expect(() => validateAgentMcpSelection(f.starts[1]!.input.mcp)).not.toThrow();
  expect(await settings.read()).toEqual(observed);
  expect((await store.readProviderExecution(first.id))!.lastRunInput?.workflow).toEqual(originalWorkflow);
});

it("dispatches a current signed workflow only after checking the persisted admitted mapping again", async () => {
  const { manager, record, input, invocation, taskAction } = await admitted();
  input.source = consumer;
  const validate = vi.fn(async () => structuredClone(invocation));
  expect(await manager.providerWorkflow(record.id, input, invocation, validate)).toEqual({ recorded: true });
  expect(validate).toHaveBeenCalledTimes(2);
  expect(taskAction).toHaveBeenCalledExactlyOnceWith(record.id, input.action, input.input, expect.any(String), expect.any(Function));
});

it.each(["user", "principal", "role", "installation", "provider", "interface", "public-session", "public-run"])("rejects mismatched %s before the session task action", async mismatch => {
  const { manager, record, input, invocation, taskAction } = await admitted();
  const current = structuredClone(invocation);
  if (mismatch === "user") { current.userId = "another-owner"; invocation.userId = current.userId; }
  if (mismatch === "principal") current.principalId = "another-principal";
  if (mismatch === "role") current.hostRole = "host.user";
  if (mismatch === "installation") input.agent.provider = { ...input.agent.provider, installationId: "reinstalled-provider" };
  if (mismatch === "provider") input.agent.provider = { ...input.agent.provider, appId: "another-provider" };
  if (mismatch === "interface") input.agent.provider = { ...input.agent.provider, key: "another-interface" };
  if (mismatch === "public-session") input.agent.sessionId = randomUUID();
  if (mismatch === "public-run") input.agent.runId = randomUUID();
  current.agentExecution = structuredClone(input.agent);
  await expect(manager.providerWorkflow(record.id, input, invocation, async () => current)).rejects.toMatchObject({ code: "workflow_binding_mismatch" });
  expect(taskAction).not.toHaveBeenCalled();
});

it("does not dispatch another logical conversation's signed public run", async () => {
  const { f, manager, record, input, invocation, taskAction } = await admitted();
  const other = await manager.createSession({ createdBy: f.owner });
  await manager.postMessage(other.id, "A separate admitted conversation", f.credential, [], { actorUserId: f.owner, clientRequestId: randomUUID() });
  expect(other.id).not.toBe(record.id);
  await expect(manager.providerWorkflow(other.id, input, invocation, async () => invocation)).rejects.toMatchObject({ code: "workflow_binding_mismatch" });
  expect(taskAction).not.toHaveBeenCalled();
});

it.each(["appId", "installationId", "key"] as const)("rejects an overlapping task source with the wrong %s", async field => {
  const { manager, record, input, invocation, taskAction } = await admitted();
  input.action = "task-get"; input.source = { ...consumer, [field]: "another-source" };
  await expect(manager.providerWorkflow(record.id, input, invocation, async () => invocation)).rejects.toMatchObject({ code: "workflow_source_mismatch" });
  expect(taskAction).not.toHaveBeenCalled();
});

it("uses the persisted task provider source when it differs from this consumer installation", async () => {
  const { f, settings, providers, taskAction } = await fixture();
  const profiles = new ProfileStore(path.join(f.root, "task-profiles"), async () => ({ name: "Executor", description: "Execute tasks",
    instructions: "Use the bound task source", connectionId: f.connectionId, model: null, reasoningEffort: null, skillIds: [] }), async () => []);
  const directory = await profiles.read(), profile = directory.profiles[0]!, executionId = randomUUID();
  const { manager, store } = f.makeManager({ settings, providers, profiles }); manager.taskAction = taskAction;
  const record = await manager.createSession({ createdBy: f.owner, taskExecutionId: executionId, profileId: profile.id, profileRevision: profile.revision });
  const source = { appId: "independent.task-source", installationId: "task-installation", key: "custom" }, ref = { ...source, id: randomUUID() };
  await manager.bindTaskContext(record.id, executionId, f.owner, { version: 1, taskRef: ref, inputRevision: 1,
    content: { title: "Bound task", markdown: "Read the current task", review: { mode: "none" }, resources: [] },
    relations: { rootTaskRef: ref, parentTaskRef: null, relationRevision: 1 }, prerequisiteOutcomes: [] });
  await manager.postMessage(record.id, "Execute the bound task", f.credential, [], { actorUserId: f.owner, clientRequestId: executionId, taskDispatch: true });
  const state = (await store.readProviderExecution(record.id))!, agent = { provider: f.provider, sessionId: state.sessionId, runId: state.runId! };
  const input: AgentSessionWorkflowRequest = { action: "task-get", input: {}, source, agent };
  const invocation: MediatedProviderInvocation = { version: 2, kind: "task-executor", key: "default", operation: "session.workflow",
    callerAppId: f.provider.appId, callerInstallation: f.provider.installationId, userId: f.owner, hostRole: "host.admin", principalId: "original-principal", resourceIds: [], agentExecution: agent };
  expect(await manager.providerWorkflow(record.id, input, invocation, async () => invocation)).toEqual({ recorded: true });
  taskAction.mockClear(); input.source = consumer;
  await expect(manager.providerWorkflow(record.id, input, invocation, async () => invocation)).rejects.toMatchObject({ code: "workflow_source_mismatch" });
  expect(taskAction).not.toHaveBeenCalled();
});

it("preserves the new admission and its workflow while installation history delivers the earlier turn's terminal", async () => {
  const { f, manager, store, record, state, input, invocation } = await admitted({ subagents: true, installationHistory: true });
  const first = state.runId!;
  f.complete(first, "Finished original turn");
  await vi.waitFor(async () => expect((await store.readRecord(record.id))!.status).toBe("idle"), { timeout: 5000 });
  const initial = f.requests.length;
  let releaseLookup!: () => void, releaseStart!: () => void;
  f.behavior.sessionLookupGate = new Promise(resolve => { releaseLookup = resolve; });
  f.behavior.startGate = new Promise(resolve => { releaseStart = resolve; });
  const posted = manager.postMessage(record.id, "Continue in this chat", f.credential, [], { actorUserId: f.owner, clientRequestId: randomUUID() });
  try {
    await vi.waitFor(() => expect(f.requests.slice(initial).some(req => req.method === "GET"
      && req.path.endsWith("/sessions/" + state.sessionId))).toBe(true), { timeout: 5000 });
    const prior = f.snapshot(first);
    const messages = [...prior.messages!, { id: "late", role: "assistant" as const, state: "complete" as const, text: "Late original detail" }];
    f.update(first, { messages });
    await vi.waitFor(async () => expect((await store.readEvents(record.id)).some(event => event.text === "Late original detail")).toBe(true), { timeout: 5000 });
    expect((await store.readRecord(record.id))!.status).toBe("running");
    releaseLookup();
    await vi.waitFor(() => expect(f.authorizations.filter(req => req.operation === "runs.start")).toHaveLength(2), { timeout: 5000 });
    const agent = { ...input.agent, runId: (await store.readProviderExecution(record.id))!.runId! };
    const actor = { ...invocation, kind: "agent-sessions" as const, agentExecution: agent };
    expect(agent.runId).not.toBe(first);
    // A chat persisted by an older Harness can still show the previous turn's idle status.
    const beforeProjection = (await store.readRecord(record.id))!;
    expect(beforeProjection.providerObservedRunId).toBe(first);
    await store.saveRecord({ ...beforeProjection, status: "idle" });
    expect(await manager.providerWorkflow(record.id, { ...input, action: "subagent-profiles", agent }, actor, async () => actor)).toMatchObject({ profiles: [{ name: "Reviewer" }] });
    await expect(manager.providerWorkflow(record.id, input, invocation, async () => invocation)).rejects.toMatchObject({ code: "workflow_binding_mismatch" });
  } finally { releaseLookup(); releaseStart(); await posted; }
  f.complete(f.starts[1]!.runId, "Finished resumed turn");
  await vi.waitFor(async () => expect((await store.readRecord(record.id))!.status).toBe("idle"), { timeout: 5000 });
}, 20000);

it("rejects a new workflow dispatch after the admitted public run has authoritatively stopped", async () => {
  const { f, manager, record, state, input, invocation, taskAction } = await admitted();
  f.complete(state.runId!);
  await vi.waitFor(async () => expect((await f.store.readRecord(record.id))!.status).toBe("idle"));
  await expect(manager.providerWorkflow(record.id, input, invocation, async () => invocation)).rejects.toMatchObject({ code: "workflow_run_inactive" });
  expect(taskAction).not.toHaveBeenCalled();
});

it("revalidates at dispatch after initial admission and preserves a current Core revocation", async () => {
  const { manager, record, input, invocation, taskAction } = await admitted();
  const validate = vi.fn().mockResolvedValueOnce(invocation).mockRejectedValueOnce(new ProviderError("permission_denied", "The original grant was revoked.", 403));
  await expect(manager.providerWorkflow(record.id, input, invocation, validate)).rejects.toMatchObject({ code: "permission_denied" });
  expect(validate).toHaveBeenCalledTimes(2); expect(taskAction).not.toHaveBeenCalled();
});
