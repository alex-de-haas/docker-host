import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ProviderError, type MediatedProviderInvocation } from "@hosty-sdk/app/providers";
import type { AgentSessionWorkflowRequest } from "@hosty-sdk/app/agent";
import type { SessionManager } from "../sessions/manager.js";
import { TaskService } from "./service.js";

let directory: string, service: TaskService | undefined;
const sessionId = "30000000-0000-4000-8000-000000000001";
const agent = { provider: { appId: "independent.provider", installationId: "native-installation", key: "coding" }, sessionId: "public-session", runId: "public-run" };
const invocation: MediatedProviderInvocation = { version: 2, kind: "task-executor", key: "default", operation: "session.workflow", userId: "original-user", principalId: "original-principal", hostRole: "host.admin", callerAppId: agent.provider.appId,
  callerInstallation: agent.provider.installationId, resourceIds: [], agentExecution: agent };
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "hosty-workflow-receipt-"));
  vi.stubEnv("HOSTY_APP_ID", "consumer"); vi.stubEnv("HOSTY_APP_INSTALLATION_ID", "consumer-installation");
  vi.stubEnv("HOSTY_CORE_ORIGIN", "http://core.test"); vi.stubEnv("HOSTY_APP_SERVICE_TOKEN", "synthetic-service");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(invocation)));
});
afterEach(async () => { await service?.close(); service = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

it.each(["task-result", "task-fail", "task-wait", "task-request-input"])("recovers the exact %s acknowledgement after response loss and consumer service restart", async action => {
  let stopped = false;
  const business = vi.fn(async () => ({ recorded: true, requestId: input.input.requestId }));
  const manager = { store: { dataDir: directory }, workspaceAction: business,
    providerWorkflow: vi.fn(async (_id: string, _input: AgentSessionWorkflowRequest, _authority: MediatedProviderInvocation,
      validate: () => Promise<MediatedProviderInvocation>, recovery: { retained: boolean; dispatch: (guard: () => Promise<void>) => Promise<unknown> }) => {
      await validate();
      if (stopped && !recovery.retained) throw new ProviderError("workflow_run_inactive", "The original attempt stopped.", 409);
      return recovery.dispatch(async () => { await validate(); });
    }) } as unknown as SessionManager;
  const input: AgentSessionWorkflowRequest = { action, input: { requestId: randomUUID(), completed: true, result: { markdown: "Verified result", resources: [] } }, agent };
  const invoke = async (value = input, loseResponse = false) => {
    const body = JSON.stringify(value), request = Readable.from([body]) as IncomingMessage;
    request.method = "POST"; request.headers = { authorization: "Bearer hosty_provider.2.exact-workflow" };
    let result = "", status = 0;
    const response = { writeHead: (code: number) => { status = code; }, end: (bytes: string) => { if (loseResponse) throw new Error("HTTP acknowledgement lost"); result = bytes; } } as unknown as ServerResponse;
    expect(await service!.route(request, response, new URL(`/api/task-executor/v1/sessions/${sessionId}/workflow`, "http://consumer.test"), async () => { throw new Error("Do not reinterpret the signed body."); })).toBe(true);
    return { status, result: JSON.parse(result) };
  };
  service = new TaskService(manager);
  await expect(invoke(input, true)).rejects.toThrow("HTTP acknowledgement lost");
  expect(business).toHaveBeenCalledOnce();
  await service.close(); stopped = true; service = new TaskService(manager);
  expect(await invoke()).toEqual({ status: 200, result: { recorded: true, requestId: input.input.requestId } });
  expect(business).toHaveBeenCalledOnce();
  await expect(invoke({ ...input, input: { ...input.input, completed: false } })).rejects.toMatchObject({ code: "request_conflict" });
  await expect(invoke({ ...input, input: { ...input.input, requestId: randomUUID() } })).rejects.toMatchObject({ code: "workflow_run_inactive" });
  expect(business).toHaveBeenCalledOnce();
});
