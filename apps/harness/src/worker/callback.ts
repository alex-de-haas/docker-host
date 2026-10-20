import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConnectionSecrets } from "../connections/secrets.js";
import { authorizeService, type ServiceIdentity } from "./auth.js";
import { json, readCommand } from "./http.js";
import { WorkerApiError } from "./contracts.js";

export function workerCallbacks(identity: ServiceIdentity, secrets: ConnectionSecrets) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const pathname = new URL(request.url ?? "/", "http://api").pathname;
    if (!pathname.startsWith("/internal/worker/")) return false;
    authorizeService(request, identity);
    if (pathname === "/internal/worker/health" && request.method === "GET") { json(response, 200, { ready: true }); return true; }
    if (pathname === "/internal/worker/secrets" && request.method === "POST") {
      const input = await readCommand(request) as { operation: string; key: string; value?: string };
      if (!input || !/^agent\.[a-z0-9-]+$/.test(input.key) || !["get", "set", "delete"].includes(input.operation)
        || input.operation === "set" && (typeof input.value !== "string" || input.value.length > 64000))
        throw new WorkerApiError(400, "invalid_secret_operation", "Invalid provider credential operation.");
      if (input.operation === "get") json(response, 200, { value: await secrets.get(input.key) });
      else { if (input.operation === "set") await secrets.set(input.key, input.value!); else await secrets.delete(input.key); json(response, 200, { saved: true }); }
      return true;
    }
    throw new WorkerApiError(404, "not_found", "Unknown worker callback.");
  };
}
