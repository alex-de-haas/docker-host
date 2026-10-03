/** Preserve provider refusal details through app-owned server transports. */
export class AssistantError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Version 1 of the manifest-discovered assistant handoff. */
export type AssistantContract = { version?: number | null; capabilities?: readonly string[] | null };
export type AssistantDestination = { endpoint: string; path: string };
export type AssistantHandoffResult = { conversationId: string; disposition: "draft" | "accepted"; open: AssistantDestination; dispatchId?: string };
export type AssistantHandoff = {
  handoffId: string; requestId: string; conversationId: string;
  state: "pending" | "finalized" | "cancelled" | "expired";
  createdAt: string; expiresAt: string; replayUntil: string;
  attachments: Array<{ attachmentId: string; name: string; mediaType: string; sizeBytes: number; sha256: string }>;
  limits?: { maxFileBytes: number; maxFiles: number; maxTotalBytes: number };
  result?: AssistantHandoffResult;
  executionState?: "queued" | "running" | "completed" | "failed" | "unknown";
};

export function assistantContractError(contract: AssistantContract): string | null {
  return contract.version !== 1 || !Array.isArray(contract.capabilities)
    ? "This assistant does not support the required assistant interface version 1." : null;
}

/** Time-bearing request identities let a provider reject retries after replay records expire. */
export function createAssistantRequestId(now = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let time = now;
  for (let i = 5; i >= 0; i--) { bytes[i] = time % 256; time = Math.floor(time / 256); }
  bytes[6] = (bytes[6]! & 15) | 112; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Resolve only inside a declared UI surface on the selected app's resolved endpoint. */
export function resolveAssistantDestination(destination: AssistantDestination, surfaces: readonly { endpoint?: string | null; path?: string | null; url?: string | null }[]): string {
  if (!destination || typeof destination.path !== "string" || !destination.path.startsWith("/") || destination.path.startsWith("//") || /[\\\u0000-\u001f]/.test(destination.path)) throw new Error("Invalid assistant UI destination.");
  if (/%(?:2f|5c|25)/i.test(destination.path.split(/[?#]/, 1)[0]!)) throw new Error("Invalid assistant UI destination.");
  for (const surface of surfaces) {
    if (surface.endpoint !== destination.endpoint || !surface.url) continue;
    const base = new URL(surface.url);
    const url = new URL(destination.path, base.origin);
    const root = new URL(surface.path || "/", base.origin).pathname.replace(/\/$/, "") || "/";
    if (url.origin === base.origin && (root === "/" || url.pathname === root || url.pathname.startsWith(`${root}/`))) return url.href;
  }
  throw new Error("The assistant returned a destination outside its declared UI.");
}

export class AssistantClient {
  private readonly baseUrl: string;
  private readonly contract: AssistantContract;
  private readonly token: (refresh: boolean) => Promise<{ token: string }>;
  constructor(baseUrl: string, contract: AssistantContract, token: (refresh: boolean) => Promise<{ token: string }>) {
    this.baseUrl = baseUrl; this.contract = contract; this.token = token;
  }

  private async request<T>(route: string, init: RequestInit = {}, controlDeadline = true): Promise<T> {
    const incompatible = assistantContractError(this.contract);
    if (incompatible) throw new Error(incompatible);
    for (let attempt = 0; attempt < 2; attempt++) {
      const grant = await this.token(attempt > 0);
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${grant.token}`);
      if (typeof init.body === "string") headers.set("content-type", "application/json");
      const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}${route}`, { ...init, redirect: "error", headers, signal: init.signal ?? (controlDeadline ? AbortSignal.timeout(60_000) : undefined) });
      if (response.status === 401 && attempt === 0) continue;
      const body = await response.json().catch(() => null) as { code?: string; message?: string } | null;
      if (!response.ok) throw new AssistantError(body?.code ?? "assistant_failed",
        body?.message || `Assistant request failed (${response.status}).`, response.status);
      return body as T;
    }
    throw new Error("Assistant authorization expired.");
  }
  prepare(input: { requestId: string; prompt: string; appIds: string[] }): Promise<AssistantHandoff> {
    return this.request("/handoffs", { method: "POST", body: JSON.stringify(input) });
  }
  upload(handoffId: string, attachmentId: string, file: Blob, name: string, options: { signal?: AbortSignal } = {}): Promise<AssistantHandoff["attachments"][number]> {
    if (!this.contract.capabilities?.includes("attachments")) throw new Error("This assistant does not support attachments.");
    return this.request(`/handoffs/${encodeURIComponent(handoffId)}/attachments/${encodeURIComponent(attachmentId)}?name=${encodeURIComponent(name)}`, {
      method: "PUT", body: file, signal: options.signal, headers: { "content-type": file.type || "application/octet-stream" },
    }, false);
  }
  finalize(handoffId: string, attachmentIds: string[]): Promise<AssistantHandoff> {
    return this.request(`/handoffs/${encodeURIComponent(handoffId)}/finalize`, { method: "POST", body: JSON.stringify({ attachmentIds }) });
  }
  status(handoffId: string): Promise<AssistantHandoff> { return this.request(`/handoffs/${encodeURIComponent(handoffId)}`); }
  cancel(handoffId: string): Promise<AssistantHandoff> { return this.request(`/handoffs/${encodeURIComponent(handoffId)}`, { method: "DELETE" }); }
}
