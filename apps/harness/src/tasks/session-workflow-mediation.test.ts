import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import type { AgentSessionWorkflowRequest } from "@hosty-sdk/app/agent";
import type { MediatedProviderInvocation } from "@hosty-sdk/app/providers";
import { mediatedSessionWorkflow } from "./session-workflow-mediation.js";

const token = "hosty_provider.2.exact.signature", sessionId = "3f236fe9-cd9c-4992-8dd2-3e17f5a4b184";
const pathname = `/api/task-executor/v1/sessions/${sessionId}/workflow`;
const agent = { provider: { appId: "independent.runner", installationId: "retained-installation", key: "coding" },
  sessionId: "6f516746-ae08-40ec-900d-1f782726a970", runId: "6d77e93a-d0c1-44c0-b221-5d1b71dd9332" };
const workflow = (): AgentSessionWorkflowRequest => ({ action: "task-result", input: { requestId: "fc486c7b-278c-4bf0-b96e-abac7d2219e2",
  completed: true, result: { markdown: "Verified result ✅", resources: [] } }, agent: structuredClone(agent) });
const invocation = (key = "default"): MediatedProviderInvocation => ({ version: 2, kind: "task-executor", key, operation: "session.workflow",
  callerAppId: agent.provider.appId, callerInstallation: agent.provider.installationId,
  userId: "original-user", hostRole: "host.admin", principalId: "original-principal", resourceIds: [], agentExecution: structuredClone(agent) });
function request(body = JSON.stringify(workflow()), options: { method?: string; authorization?: string; cookie?: string; chunks?: Buffer[] } = {}) {
  const stream = Readable.from(options.chunks ?? [Buffer.from(body)]) as unknown as IncomingMessage;
  stream.method = options.method ?? "POST";
  stream.headers = { authorization: options.authorization ?? `Bearer ${token}`, ...(options.cookie !== undefined ? { cookie: options.cookie } : {}) };
  return stream;
}
function introspection(value = invocation()) {
  const fetcher = vi.fn(async () => Response.json(value)); vi.stubGlobal("fetch", fetcher); return fetcher;
}
beforeEach(() => {
  vi.stubEnv("HOSTY_APP_ID", "unrelated.consumer"); vi.stubEnv("HOSTY_CORE_ORIGIN", "http://core.test");
  vi.stubEnv("HOSTY_APP_SERVICE_TOKEN", "consumer-service-secret");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("introspects the exact original bytes, method, path and interface key through the real SDK client", async () => {
  const fetcher = introspection(invocation("workflow")), body = JSON.stringify(workflow(), null, 2) + "\n";
  const bytes = Buffer.from(body), split = bytes.indexOf(Buffer.from("✅")) + 1;
  const mediated = await mediatedSessionWorkflow(request(body, { chunks: [bytes.subarray(0, split), bytes.subarray(split)] }), new URL(pathname, "http://consumer.test"), "workflow");
  expect(mediated).not.toBeNull(); expect(mediated!.sessionId).toBe(sessionId);
  expect(await mediated!.read()).toEqual(workflow()); expect(mediated!.invocation).toEqual(invocation("workflow"));
  const [url, init] = fetcher.mock.calls[0]! as unknown as [URL, RequestInit];
  expect(String(url)).toBe("http://core.test/api/internal/apps/unrelated.consumer/provider/introspect-v2");
  expect(new Headers(init.headers).get("authorization")).toBe("Bearer consumer-service-secret");
  expect(JSON.parse(String(init.body))).toEqual({ token, kind: "task-executor", key: "workflow", operation: "session.workflow",
    method: "POST", path: `/sessions/${sessionId}/workflow`, bodyHash: createHash("sha256").update(bytes).digest("hex") });
});

it("revalidates retained bytes and the signed execution at every dispatch guard without trusting a mutated read result", async () => {
  const fetcher = introspection(), mediated = (await mediatedSessionWorkflow(request(), new URL(pathname, "http://consumer.test")))!;
  const changed = await mediated.read(); changed.agent.runId = "replacement"; changed.input.completed = false;
  expect(await mediated.read()).toEqual(workflow());
  await mediated.validate(); expect(fetcher).toHaveBeenCalledTimes(2);
  const calls = fetcher.mock.calls as unknown as Array<[URL, RequestInit]>;
  expect(String(calls[1]![0])).toBe(String(calls[0]![0]));
  expect(calls[1]![1].body).toBe(calls[0]![1].body);
  expect(calls[1]![1].headers).toEqual(calls[0]![1].headers);
  fetcher.mockImplementationOnce(async () => Response.json({ ...invocation(), agentExecution: { ...agent, runId: "another-public-run" } }));
  await expect(mediated.validate()).rejects.toMatchObject({ code: "permission_denied", status: 403 });
});

it("preserves an optional qualified task source in the exact signed body without assuming its identity", async () => {
  const fetcher = introspection(), source = { appId: "another.task-source", installationId: "source-installation", key: "work", implementationId: "board-a" };
  const value = { ...workflow(), action: "task-get", source }, body = JSON.stringify(value);
  const mediated = (await mediatedSessionWorkflow(request(body), new URL(pathname, "http://consumer.test")))!;
  expect(await mediated.read()).toEqual(value);
  const [, init] = fetcher.mock.calls[0]! as unknown as [URL, RequestInit];
  expect(JSON.parse(String(init.body)).bodyHash).toBe(createHash("sha256").update(body).digest("hex"));
  await mediated.validate(); expect(fetcher).toHaveBeenCalledTimes(2);
});

it("rejects a sibling named agent on dispatch after admitting the exact selected implementation", async () => {
  const named = { ...agent, provider: { ...agent.provider, implementationId: "work" } };
  const fetcher = introspection({ ...invocation(), agentExecution: named });
  const body = JSON.stringify({ ...workflow(), agent: named });
  const mediated = (await mediatedSessionWorkflow(request(body), new URL(pathname, "http://consumer.test")))!;
  expect((await mediated.read()).agent).toEqual(named);
  fetcher.mockImplementationOnce(async () => Response.json({ ...invocation(), agentExecution: { ...named,
    provider: { ...named.provider, implementationId: "personal" } } }));
  await expect(mediated.validate()).rejects.toMatchObject({ code: "permission_denied", status: 403 });
});

it("compares signed agent fields independently of JSON object field order", async () => {
  introspection();
  const value = { ...workflow(), agent: { runId: agent.runId, provider: { key: agent.provider.key,
    installationId: agent.provider.installationId, appId: agent.provider.appId }, sessionId: agent.sessionId } };
  const mediated = await mediatedSessionWorkflow(request(JSON.stringify(value)), new URL(pathname, "http://consumer.test"));
  expect(await mediated!.read()).toEqual(workflow());
});

it.each(["userId", "principalId"] as const)("rejects a changed original %s during dispatch revalidation", async field => {
  const fetcher = introspection(), mediated = (await mediatedSessionWorkflow(request(), new URL(pathname, "http://consumer.test")))!;
  fetcher.mockImplementationOnce(async () => Response.json({ ...invocation(), [field]: "replacement-actor" }));
  await expect(mediated.validate()).rejects.toMatchObject({ code: "token_invalid", status: 401 });
});

it("propagates a current Core denial during dispatch revalidation", async () => {
  const fetcher = introspection(), mediated = (await mediatedSessionWorkflow(request(), new URL(pathname, "http://consumer.test")))!;
  fetcher.mockImplementationOnce(async () => Response.json({ code: "permission_denied", message: "The originating grant was revoked." }, { status: 403 }));
  await expect(mediated.validate()).rejects.toMatchObject({ code: "permission_denied", status: 403 });
});

it("leaves unrelated routes to their owning handler", async () => {
  const fetcher = introspection();
  expect(await mediatedSessionWorkflow(request(), new URL("/api/task-executor/v1/options", "http://consumer.test"))).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});

it.each([
  ["GET", pathname], ["PUT", pathname], ["POST", pathname + "?operation=session.workflow"],
] as const)("rejects %s %s before introspection", async (method, route) => {
  const fetcher = introspection();
  await expect(mediatedSessionWorkflow(request(undefined, { method }), new URL(route, "http://consumer.test")))
    .rejects.toMatchObject({ code: "permission_denied", status: 403 });
  expect(fetcher).not.toHaveBeenCalled();
});

it.each(["", "Bearer hosty_provider.1.old.signature", "Bearer ordinary-user", `Bearer ${token} additional`, "Basic credential"])("rejects non-v2 workflow authentication %j", async authorization => {
  const fetcher = introspection();
  await expect(mediatedSessionWorkflow(request(undefined, { authorization }), new URL(pathname, "http://consumer.test")))
    .rejects.toMatchObject({ code: "token_invalid", status: 401 });
  expect(fetcher).not.toHaveBeenCalled();
});

it.each(["session=browser-credential", ""])("rejects a cookie combined with mediated authority (%j)", async cookie => {
  const fetcher = introspection();
  await expect(mediatedSessionWorkflow(request(undefined, { cookie }), new URL(pathname, "http://consumer.test")))
    .rejects.toMatchObject({ code: "token_invalid", status: 401 });
  expect(fetcher).not.toHaveBeenCalled();
});

it.each(["provider.appId", "provider.installationId", "provider.key", "sessionId", "runId"])("rejects a body whose %s differs from signed execution provenance", async field => {
  introspection(); const value = workflow();
  if (field.startsWith("provider.")) value.agent.provider[field.slice(9) as keyof typeof agent.provider] = "different";
  else value.agent[field as "sessionId" | "runId"] = "different";
  await expect(mediatedSessionWorkflow(request(JSON.stringify(value)), new URL(pathname, "http://consumer.test")))
    .rejects.toMatchObject({ code: "permission_denied", status: 403 });
});

it.each([
  { ...workflow(), action: "task_result" }, { ...workflow(), action: "task-unknown" }, { ...workflow(), action: "environment-create" },
  { ...workflow(), input: [] }, { ...workflow(), input: null }, { ...workflow(), extra: true },
  { ...workflow(), agent: { ...agent, nativeSessionId: "private" } },
  { ...workflow(), agent: { ...agent, provider: { ...agent.provider, installationId: "" } } },
  { ...workflow(), source: null }, { ...workflow(), source: [] },
  { ...workflow(), source: { appId: "source", key: "default" } },
  { ...workflow(), source: { appId: "source", installationId: "", key: "default" } },
  { ...workflow(), source: { appId: "source", installationId: "installed", key: "default", extra: true } },
])("rejects malformed or unknown workflow payloads before authority lookup (%j)", async body => {
  const fetcher = introspection();
  await expect(mediatedSessionWorkflow(request(JSON.stringify(body)), new URL(pathname, "http://consumer.test")))
    .rejects.toMatchObject({ code: "invalid_input", status: 400 });
  expect(fetcher).not.toHaveBeenCalled();
});

it.each(["not json", "[]", "null"])("rejects invalid workflow JSON %j", async body => {
  const fetcher = introspection();
  await expect(mediatedSessionWorkflow(request(body), new URL(pathname, "http://consumer.test"))).rejects.toMatchObject({ code: "invalid_input", status: 400 });
  expect(fetcher).not.toHaveBeenCalled();
});

it.each(["userId", "principalId", "agentExecution"] as const)("rejects introspection without %s", async field => {
  introspection({ ...invocation(), [field]: undefined } as unknown as MediatedProviderInvocation);
  await expect(mediatedSessionWorkflow(request(), new URL(pathname, "http://consumer.test"))).rejects.toMatchObject({ code: "token_invalid", status: 401 });
});

it("accepts the exact byte ceiling and rejects excess data before Core introspection", async () => {
  const fetcher = introspection(), payload = Buffer.from(JSON.stringify(workflow())), padding = Buffer.alloc(1024 * 1024 - payload.length, 0x20);
  expect(await mediatedSessionWorkflow(request(undefined, { chunks: [payload, padding] }), new URL(pathname, "http://consumer.test"))).not.toBeNull();
  fetcher.mockClear();
  await expect(mediatedSessionWorkflow(request(undefined, { chunks: [payload, padding, Buffer.from(" ")] }), new URL(pathname, "http://consumer.test")))
    .rejects.toMatchObject({ code: "budget_exceeded", status: 413 });
  expect(fetcher).not.toHaveBeenCalled();
});
