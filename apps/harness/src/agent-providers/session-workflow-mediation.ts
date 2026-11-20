import type { IncomingMessage } from "node:http";
import { AGENT_SUBAGENT_WORKFLOW_TOOLS, type AgentExecutionReference, type AgentSessionWorkflowRequest } from "@hosty-sdk/app/agent";
import { ProviderClient } from "@hosty-sdk/app/providers/server";
import { ProviderError, type MediatedProviderInvocation } from "@hosty-sdk/app/providers";
import { taskActions } from "../tasks/tools.js";

const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const fields = (value: Record<string, unknown>, names: string[]) => Object.keys(value).length === names.length && Object.keys(value).every(key => names.includes(key));
const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512
  && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
const sameAgent = (a: AgentExecutionReference, b: AgentExecutionReference) => a.sessionId === b.sessionId && a.runId === b.runId
  && a.provider.appId === b.provider.appId && a.provider.installationId === b.provider.installationId && a.provider.key === b.provider.key;

const subagentActions = AGENT_SUBAGENT_WORKFLOW_TOOLS.map(name => name.replaceAll("_", "-"));

function readWorkflow(bytes: Buffer, kind: "task-executor" | "agent-sessions"): AgentSessionWorkflowRequest {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { throw new ProviderError("invalid_input", "Expected a JSON workflow request.", 400); }
  if (!object(value) || !fields(value, ["action", "input", "agent", ...(Object.hasOwn(value, "source") ? ["source"] : [])]) || typeof value.action !== "string"
    || !(kind === "task-executor" ? taskActions : subagentActions).some(action => action === value.action) || !object(value.input) || !object(value.agent)
    || !fields(value.agent, ["provider", "sessionId", "runId"]) || !identity(value.agent.sessionId) || !identity(value.agent.runId)
    || !object(value.agent.provider) || !fields(value.agent.provider, ["appId", "installationId", "key"])
    || ![value.agent.provider.appId, value.agent.provider.installationId, value.agent.provider.key].every(identity)
    || Object.hasOwn(value, "source") && (kind !== "task-executor" || !object(value.source) || !fields(value.source, ["appId", "installationId", "key"])
      || ![value.source.appId, value.source.installationId, value.source.key].every(identity)))
    throw new ProviderError("invalid_input", "Use a declared session action, object input and qualified public agent execution.", 400);
  return value as unknown as AgentSessionWorkflowRequest;
}

/** Exact Core mediation for optional consumer-owned business actions, never native execution callbacks. */
export async function mediatedSessionWorkflow(request: IncomingMessage, url: URL, key = "default", kind: "task-executor" | "agent-sessions" = "task-executor") {
  const root = `/api/${kind}/v1`;
  if (!url.pathname.startsWith(root + "/")) return null;
  const path = url.pathname.slice(root.length);
  const route = path.match(/^\/sessions\/([^/]+)\/workflow$/);
  if (!route) return null;
  if (request.method !== "POST" || url.search) throw new ProviderError("permission_denied", "Use the exact POST session workflow route without a query.", 403);
  let sessionId: string;
  try { sessionId = decodeURIComponent(route[1]!); }
  catch { throw new ProviderError("invalid_input", "Invalid consumer session identity.", 400); }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(sessionId)) throw new ProviderError("invalid_input", "Invalid consumer session identity.", 400);
  const token = request.headers.authorization?.match(/^Bearer (hosty_provider\.2\.[^\s]+)$/)?.[1];
  if (!token || request.headers.cookie !== undefined) throw new ProviderError("token_invalid", "Use only an exact Core-mediated workflow credential.", 401);
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > 1024 * 1024) throw new ProviderError("budget_exceeded", "Workflow requests are bounded to 1 MiB.", 413);
    chunks.push(bytes);
  }
  const bytes = Buffer.concat(chunks), input = readWorkflow(bytes, kind), client = new ProviderClient();
  let original: Pick<MediatedProviderInvocation, "userId" | "principalId"> | undefined;
  const validate = async (): Promise<MediatedProviderInvocation> => {
    const invocation = await client.validateMediated(token, kind, { operation: "session.workflow", method: "POST", path, body: bytes }, key);
    if (!identity(invocation.userId) || !identity(invocation.principalId) || !invocation.agentExecution)
      throw new ProviderError("token_invalid", "The workflow requires its original user, principal and admitted public execution.", 401);
    if (!sameAgent(input.agent, invocation.agentExecution))
      throw new ProviderError("permission_denied", "The workflow body does not identify the signed admitted execution.", 403);
    if (original && (invocation.userId !== original.userId || invocation.principalId !== original.principalId))
      throw new ProviderError("token_invalid", "The original workflow actor changed during dispatch.", 401);
    return invocation;
  };
  const invocation = await validate(); original = { userId: invocation.userId, principalId: invocation.principalId };
  return { sessionId, invocation, validate, read: async (): Promise<AgentSessionWorkflowRequest> => structuredClone(input) };
}
