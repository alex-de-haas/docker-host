import type { IncomingMessage } from "node:http";
import { ProviderClient } from "@hosty-sdk/app/providers/server";
import { ProviderError, type MediatedProviderInvocation } from "@hosty-sdk/app/providers";

/** Bind source authorization to actual bytes and route, including the original query string. */
export async function mediatedTaskRequest(request: IncomingMessage, url: URL, kind: "tasks" | "task-executor", key: string) {
  const token = request.headers.authorization?.match(/^Bearer (hosty_provider\.2\.[^\s]+)$/)?.[1];
  if (!token) return null;
  if (request.headers.cookie) throw new ProviderError("token_invalid", "Do not combine mediated requests with browser credentials.", 401);
  const route = url.pathname.slice(kind === "tasks" ? "/api/tasks/v1".length : "/api/task-executor/v1".length), method = request.method ?? "GET";
  let operations: string[] = [];
  if (kind === "tasks") {
    if (route === "/capabilities" && method === "GET" && !url.search) operations = ["options"];
    else if (route === "/tasks") operations = method === "GET" ? ["list"] : method === "POST" && !url.search ? ["create"] : [];
    else if (/^\/tasks\/[a-f0-9-]{36}$/i.test(route) && !url.search) operations = method === "GET" ? ["get"] : method === "PATCH" ? ["edit"] : [];
    else if (/^\/tasks\/[a-f0-9-]{36}\/actions$/i.test(route) && method === "POST" && !url.search) operations = ["action", "execute"];
  } else if (!url.search) {
    if (route === "/options" && method === "GET") operations = ["options", "dispatch.options"];
    else if (/^\/executions\/[a-f0-9-]{36}$/i.test(route)) operations = method === "GET" ? ["dispatch.get"] : method === "PUT" ? ["dispatch.accept"] : [];
    else if (/^\/executions\/[a-f0-9-]{36}\/cancel$/i.test(route) && method === "POST") operations = ["dispatch.cancel"];
  }
  if (!operations.length) throw new ProviderError("permission_denied", "This route is outside the common Core task interface.", 403);
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) { size += chunk.length; if (size > 1024 * 1024) throw new ProviderError("budget_exceeded", "Task requests are bounded to 1 MiB.", 413); chunks.push(Buffer.from(chunk)); }
  const bytes = Buffer.concat(chunks), client = new ProviderClient();
  const validate = async (): Promise<MediatedProviderInvocation> => {
    for (let index = 0; index < operations.length; index++) {
      try { return await client.validateMediated(token, kind, { operation: operations[index]!, method, path: route + url.search, body: bytes }, key); }
      catch (error) { if (!(error instanceof ProviderError) || error.code !== "token_invalid" || index === operations.length - 1) throw error; }
    }
    throw new ProviderError("token_invalid", "The task operation is not authorized.", 401);
  };
  const invocation = await validate();
  return { invocation, validate, read: async () => {
    let value: unknown; try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new ProviderError("invalid_input", "Expected a JSON task input.", 400); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProviderError("invalid_input", "Expected a JSON object.", 400);
    return value as Record<string, unknown>;
  } };
}
