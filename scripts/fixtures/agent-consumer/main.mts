/** Disposable third-party consumer. Its only execution dependency is the public Hosty SDK. */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { AgentApiError, type AgentAuthorizationRequest, type AgentOperationAuthorization, type AgentProviderRef, type AgentRunSnapshot } from "@hosty-sdk/app/agent";
import { AgentClient, prepareAgentRun } from "@hosty-sdk/app/agent/client";
import { isValidCodeVerifier } from "@hosty-sdk/app/app-code";

const cookie = "independent_consumer_session";
const json = (response: ServerResponse, status: number, value: unknown) => {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(value));
};
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers["content-type"]?.split(";")[0] !== "application/json") throw new AgentApiError("json_required", "Send JSON.", 415);
  const parts: Buffer[] = []; let bytes = 0;
  for await (const part of request) { const chunk = Buffer.from(part); bytes += chunk.length; if (bytes > 16384) throw new AgentApiError("body_budget", "Request too large.", 413); parts.push(chunk); }
  const value = JSON.parse(Buffer.concat(parts).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AgentApiError("invalid_input", "Send an object.", 400);
  return value;
}
function assert(value: unknown, message: string): asserts value { if (!value) throw new AgentApiError("acceptance_failed", message, 500); }
async function denied(action: () => Promise<unknown>, options: { changedProvider?: boolean } = {}): Promise<{ status: number; code: string }> {
  try { await action(); } catch (error) {
    // Core deliberately reports an obsolete installation as unavailable. Only this
    // exact negative-selection probe accepts that documented service failure.
    if (error instanceof AgentApiError && (error.status >= 400 && error.status < 500
      || options.changedProvider && error.status === 503 && error.code === "provider_unavailable")) return { status: error.status, code: error.code };
    throw error;
  }
  throw new AgentApiError("acceptance_failed", "An unauthorized operation unexpectedly succeeded.", 500);
}

export function createConsumer(options: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {}) {
  const env = options.env ?? process.env, fetcher = options.fetch ?? fetch;
  const appId = env.HOSTY_APP_ID!, service = env.HOSTY_APP_SERVICE_TOKEN!, core = env.HOSTY_CORE_ORIGIN!;
  let probing = false;
  const coreJson = async <T,>(path: string, input?: unknown, user?: string, signal?: AbortSignal): Promise<T> => {
    assert(appId && service && core, "The fixture must run as a Core-managed application.");
    const response = await fetcher(new URL(path, core), { method: input === undefined ? "GET" : "POST", redirect: "error", cache: "no-store",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      headers: { authorization: `Bearer ${service}`, "content-type": "application/json", ...(user ? { "X-Hosty-User-Token": user } : {}) },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const value = await response.json() as T & { code?: string; error?: { code?: string } };
    if (!response.ok) throw new AgentApiError(value.error?.code ?? value.code ?? "core_denied", "Core refused the fixture operation.", response.status);
    return value;
  };
  const identity = async (token: string | null) => {
    if (!token) throw new AgentApiError("app_identity_required", "Sign in through Core.", 401);
    const result = await coreJson<{ active: boolean; appId: string; userId: string }>("/api/auth/apps/revalidate", { accessToken: token });
    if (!result.active || result.appId !== appId || !result.userId) throw new AgentApiError("app_identity_required", "Use this application's current identity.", 401);
    return result;
  };
  const client = (provider: AgentProviderRef, token?: string) => new AgentClient({ provider, fetch: fetcher, authorize: (request: AgentAuthorizationRequest, signal) =>
    coreJson<AgentOperationAuthorization>(`/api/internal/apps/${encodeURIComponent(appId)}/agent/authorize`, { provider, ...request }, token, signal) });
  const completed = async (agent: AgentClient, runId: string) => {
    const signal = AbortSignal.timeout(90000); let snapshot: AgentRunSnapshot | undefined;
    for await (const item of agent.watchRun(runId, { signal })) {
      if (item.kind === "snapshot") snapshot = item.snapshot;
      else if (item.event.type === "run.updated") snapshot = item.event.data.snapshot as AgentRunSnapshot;
    }
    assert(snapshot?.state === "succeeded" && snapshot.stopConfirmed && snapshot.result?.text?.includes("hello"), "The plain turn did not return its terminal result and native stop proof.");
    // Replay actual SSE even if the native fixture finished before watchRun's first snapshot.
    let replay = 0, terminal = false;
    for await (const item of agent.events(runId, { signal })) {
      replay++;
      if (item.event.type === "run.updated" && (item.event.data.snapshot as AgentRunSnapshot).stopConfirmed) { terminal = true; break; }
    }
    assert(replay > 0 && terminal, "The public SSE replay omitted terminal stop proof.");
    return { runId, state: snapshot.state, stopConfirmed: snapshot.stopConfirmed, replayedEvents: replay };
  };
  const probe = async (input: Record<string, unknown>, token: string) => {
    assert(typeof input.providerAppId === "string" && typeof input.connectionId === "string" && typeof input.connectionRevision === "string", "Select the exact test provider account.");
    const discovery = await coreJson<{ providers: Array<AgentProviderRef & { available: boolean; version: number }> }>(`/api/internal/apps/${encodeURIComponent(appId)}/providers/agent`, undefined, token);
    const provider = discovery.providers.find(item => item.appId === input.providerAppId && item.available && item.version === 1);
    assert(provider?.installationId, "The explicit provider installation is unavailable.");
    const ref: AgentProviderRef = { appId: provider.appId, installationId: provider.installationId, key: provider.key }, agent = client(ref, token);
    const noActor = await denied(() => client(ref).capabilities());
    const staleProvider = await denied(() => client({ ...ref, installationId: "uninstalled-" + randomUUID() }, token).capabilities(), { changedProvider: true });
    const accounts = await agent.connections(), account = accounts.connections.find(item => item.id === input.connectionId);
    assert(account?.ready && account.revision === input.connectionRevision, "Select the account's exact current public revision.");
    const staleSessionId = randomUUID();
    const staleAccount = await denied(() => agent.createSession(staleSessionId, { configuration: { connection: { id: account.id, revision: String(BigInt(account.revision) + 1n) } } }));
    const sessionId = randomUUID();
    let session = await agent.createSession(sessionId, { configuration: { connection: { id: account.id, revision: account.revision } } });
    assert(!session.resolvedSkills.length, "A plain consumer unexpectedly inherited caller skills.");
    const runs = [];
    for (const continuation of ["start", "resume"] as const) {
      const runId = randomUUID(), prepared = prepareAgentRun(sessionId, runId, { expectedSessionRevision: session.revision,
        configurationRevision: session.configurationRevision, continuation, input: { text: "hello" } });
      prepared.configurationDigest = session.configurationDigest;
      await agent.execute(prepared); runs.push(await completed(agent, runId)); session = await agent.session(sessionId);
      assert(session.ref.id === sessionId && session.activeRun === null, "The public session did not retain confirmed continuation state.");
    }
    const listed = await agent.sessions();
    assert(!listed.sessions.some(item => item.ref.id === staleSessionId), "A rejected account revision created a provider session.");
    return { appId, provider: ref, connection: { id: account.id, revision: account.revision }, sessionId, runs, denied: { noActor, staleProvider, staleAccount }, configuration: session.configuration };
  };
  return async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const url = new URL(request.url ?? "/", "http://fixture.invalid"), method = request.method ?? "GET";
      if (method === "GET" && url.pathname === "/healthz") return json(response, 200, { status: "ok" });
      if (method === "GET" && url.pathname === "/") return json(response, 200, { appId, fixture: "independent-public-agent-consumer" });
      if (method !== "POST" || !["/api/auth/exchange", "/probe"].includes(url.pathname)) throw new AgentApiError("not_found", "Route not found.", 404);
      const origin = request.headers.origin;
      if (!origin || new URL(origin).host !== request.headers.host) throw new AgentApiError("same_origin_required", "Use the consumer's own origin.", 403);
      const input = await body(request);
      if (url.pathname === "/api/auth/exchange") {
        if (typeof input.code !== "string" || !isValidCodeVerifier(input.codeVerifier)) throw new AgentApiError("proof_required", "Use an app-owned sign-in proof.", 400);
        const result = await coreJson<{ accessToken: string; expiresInSeconds: number }>("/api/auth/apps/token", { code: input.code, codeVerifier: input.codeVerifier });
        await identity(result.accessToken);
        assert(typeof result.accessToken === "string" && Number.isSafeInteger(result.expiresInSeconds) && result.expiresInSeconds > 0, "Core returned no usable app grant.");
        const secure = request.headers["x-forwarded-proto"] === "https" || "encrypted" in request.socket;
        response.setHeader("set-cookie", `${cookie}=${encodeURIComponent(result.accessToken)}; HttpOnly; Path=/; Max-Age=${result.expiresInSeconds}; SameSite=${secure ? "None; Secure" : "Lax"}`);
        return json(response, 200, { authenticated: true });
      }
      const part = request.headers.cookie?.split(";").map(item => item.trim()).find(item => item.startsWith(cookie + "="));
      const token = part ? decodeURIComponent(part.slice(cookie.length + 1)) : null;
      await identity(token);
      if (probing) throw new AgentApiError("probe_busy", "The test consumer already owns a probe.", 409);
      probing = true;
      try { return json(response, 200, await probe(input, token!)); } finally { probing = false; }
    } catch (error) {
      const known = error instanceof AgentApiError;
      json(response, known ? error.status : 500, { error: { code: known ? error.code : "fixture_failed", message: known ? error.message : "The independent consumer check failed." } });
    }
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createServer((request, response) => { void createHandler(request, response); }).listen(Number(process.env.HOSTY_PORT_HTTP ?? process.env.PORT ?? 3528), "0.0.0.0");
}
const createHandler = createConsumer();
