import type { ProviderServerOptions } from "@hosty-sdk/app/providers/server";
import { UiError, type PanelTarget, type UiBootstrap, type UiPanel, type UiResolvedPanel, type UiNavigationCatalog, type UiNavigationTarget, type UiResolvedNavigation } from "@hosty-sdk/app/ui/types";

/** Server transport for generic UI metadata. Credentials never appear in returned metadata. */
export class UiServerClient {
  private readonly appId: string;
  private readonly core: URL;
  private readonly service: string;
  constructor(options: ProviderServerOptions = {}) {
    this.appId = options.appId ?? process.env.HOSTY_APP_ID ?? "";
    this.core = new URL(options.coreOrigin ?? process.env.HOSTY_CORE_ORIGIN ?? "http://127.0.0.1:7070");
    this.service = options.serviceToken ?? process.env.HOSTY_APP_SERVICE_TOKEN ?? "";
    if (!this.appId || !this.service) throw new UiError("hosty_misconfigured", "Hosty app credentials are not configured.", 503);
  }
  private async request<T>(path: string, token: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    if (!token) throw new UiError("app_identity_required", "Sign in to use application panels.", 401);
    const response = await fetch(new URL(`/api/internal/apps/${encodeURIComponent(this.appId)}/ui/${path}`, this.core), {
      method: body === undefined ? "GET" : "POST", redirect: "error", cache: "no-store",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${this.service}`, "X-Hosty-User-Token": token, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json().catch(() => null) as ({ code?: string; message?: string } & T) | null;
    if (response.status === 404) throw new UiError("unsupported_core", "Update Core to use application panels.", 409);
    if (!response.ok) throw new UiError(value?.code ?? "ui_unavailable", value?.message ?? "Application panels are unavailable.", response.status);
    if (!value) throw new UiError("ui_response_invalid", "Core returned invalid panel metadata.", 502);
    return value as T;
  }
  bootstrap(options: { parentOrigin?: string }, token: string, signal?: AbortSignal): Promise<UiBootstrap> {
    return this.request(`bootstrap${options.parentOrigin ? `?parentOrigin=${encodeURIComponent(options.parentOrigin)}` : ""}`, token, undefined, signal);
  }
  async listPanels(token: string, signal?: AbortSignal): Promise<UiPanel[]> {
    return (await this.request<{ panels: UiPanel[] }>("panels", token, undefined, signal)).panels;
  }
  navigation(token: string, signal?: AbortSignal): Promise<UiNavigationCatalog> {
    return this.request("navigation", token, undefined, signal);
  }
  resolveNavigation(target: UiNavigationTarget, token: string, signal?: AbortSignal): Promise<UiResolvedNavigation> {
    return this.request("navigation/resolve", token, target, signal);
  }
  resolvePanel(target: PanelTarget, token: string, signal?: AbortSignal): Promise<UiResolvedPanel> {
    return this.request("panels/resolve", token, target, signal);
  }
}

const responseHeaders = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
type UiAuthenticatedContext = { session: { status: "active"; identity: { hostRole: string | null } } | { status: "not-present" | "expired" | "forbidden" | "unavailable" | "misconfigured" }; token: string | null };

/** A fixed Web Request/Response adapter; never a caller-chosen Core proxy. */
export async function createHostyUiResponse(request: Request, context: UiAuthenticatedContext,
  options: ProviderServerOptions & { administratorOnly?: boolean; uiPath?: string } = {}): Promise<Response> {
  try {
    if (context.session.status !== "active" || !context.token) {
      const state = context.session.status;
      return Response.json({ code: state, message: "Sign in to use application panels." },
        { status: state === "forbidden" ? 403 : state === "unavailable" ? 503 : 401, headers: responseHeaders });
    }
    if (options.administratorOnly && context.session.identity.hostRole !== "host.admin")
      throw new UiError("admin_required", "This application requires administrator access.", 403);
    const url = new URL(request.url);
    const prefix = (options.uiPath ?? "/api/hosty/ui").replace(/\/$/, "");
    const route = url.pathname.startsWith(prefix + "/") ? url.pathname.slice(prefix.length + 1) : "";
    const client = new UiServerClient(options);
    let result: unknown;
    if (request.method === "GET" && route === "bootstrap") {
      if ([...url.searchParams.keys()].some(k => k !== "parentOrigin") || url.searchParams.getAll("parentOrigin").length > 1)
        throw new UiError("ui_request_invalid", "Invalid bootstrap request.", 400);
      result = await client.bootstrap({ parentOrigin: url.searchParams.get("parentOrigin") ?? undefined }, context.token, request.signal);
    } else if (request.method === "GET" && route === "panels") {
      result = { panels: await client.listPanels(context.token, request.signal) };
    } else if (request.method === "GET" && route === "navigation") {
      if (url.search) throw new UiError("ui_request_invalid", "Unexpected navigation parameters.", 400);
      result = await client.navigation(context.token, request.signal);
    } else if (request.method === "POST" && (route === "panels/resolve" || route === "navigation/resolve")) {
      if (!sameOrigin(request) || request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json")
        throw new UiError("origin_denied", "Open panels from this application page.", 403);
      const body = await boundedBody(request);
      result = route === "panels/resolve" ? await client.resolvePanel(JSON.parse(body), context.token, request.signal)
        : await client.resolveNavigation(JSON.parse(body), context.token, request.signal);
    } else throw new UiError("ui_route_not_found", "Unknown panel operation.", 404);
    return Response.json(result, { headers: responseHeaders });
  } catch (error) {
    const known = error instanceof UiError;
    return Response.json({ code: known ? error.code : error instanceof SyntaxError ? "ui_request_invalid" : "ui_unavailable",
      message: known ? error.message : "Application panels are unavailable. Retry opening the same target." },
    { status: known ? error.status : error instanceof SyntaxError ? 400 : 503, headers: responseHeaders });
  }
}

async function boundedBody(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 16_384) { await reader.cancel(); throw new UiError("ui_request_invalid", "Panel request is too large.", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

function sameOrigin(request: Request): boolean {
  try {
    const origin = request.headers.get("origin");
    const source = new URL(origin ?? "");
    const requestUrl = new URL(request.url);
    const destination = new URL(`${source.protocol}//${request.headers.get("host") ?? requestUrl.host}`);
    return origin === source.origin && ["http:", "https:"].includes(source.protocol) && origin === destination.origin
      && (source.protocol === requestUrl.protocol || request.headers.get("sec-fetch-site") === "same-origin");
  } catch { return false; }
}
