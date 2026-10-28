import { TaskService } from "./tasks/service.js";
import { isSkillManagementRoute, manageSkills, migrateSkillSelection, validSkillIds } from "./skills.js";
import { createHash } from "node:crypto";
import { WorkerApiError } from "./worker/contracts.js";
import { EventStreamTransport } from "./event-stream-transport.js";
import type { ConnectionService } from "./connections/service.js";
import { WorkerError } from "./runtime/errors.js";
import { createHostySessionResponse } from "@hosty-sdk/app/session/server";
import { createHostyUiResponse } from "@hosty-sdk/app/ui/server";
import { readOwnPermissionNotice } from "@hosty-sdk/app/permissions/server";
import { delegationCredential } from "./session-delegation.js";
import { speechRoute } from "./speech.js";
import { translationRoute } from "./translation/routes.js";
import { isTranslationKind, TranslationService } from "./translation/service.js";
import { ProviderClient } from "@hosty-sdk/app/providers/server";
import { ProviderError, type ProviderInvocation } from "@hosty-sdk/app/providers";
import { HandoffStore } from "./handoff/store.js";
import { ConnectionError } from "./connections/errors.js";
import type { AgentConnections } from "./connections/registry.js";
import { AppContextError, readContextApps, parseAppIds, captureContext, contextFromRoster } from "./sessions/app-context.js";
import { AttachmentRefusedError, listAttachments, storeAttachment, type AttachmentRefusal } from "./sessions/attachments.js";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isSameOriginRequest, resolveAdminActor } from "./auth.js";
import { readAppCredential, resolveAppSession, exchangeLaunchCode, getAppRecoveryParams } from "./app-session.js";
import { isValidCodeVerifier } from "@hosty-sdk/app/app-code";
import { isSourceConnectionRoute, requestSourceConnection } from "./source-connections.js";
import { isWorkspaceAccessReviewRoute, requestWorkspaceAccessReview } from "./workspace-access-reviews.js";
import { workspaceApplicationsRoute } from "./workspace-applications.js";
import { serveStaticSite } from "./settings/static-site.js";

// Upper bound for an event stream opened with an app session rather than a delegated token: the
// cookie is re-validated per request, but a stream is one request, so it gets an explicit ceiling.
const APP_SESSION_STREAM_SECONDS = 3600;
import { SessionBusyError, SessionNotFoundError, type SessionManager } from "./sessions/manager.js";
import type { HarnessAdapter } from "./harness/adapter.js";
import { MAX_SYSTEM_PROMPT_CHARS, type SettingsStore } from "./settings/store.js";
import { validRetention } from "./settings/store.js";
import { DEFAULT_WORKFLOW_PROMPT } from "./settings/workflow.js";
import type { ProviderDirectory } from "./settings/providers.js";
import { serverName } from "./mcp/exchange.js";
import type { McpProxy } from "./mcp/proxy.js";
import type { McpFacade } from "./facade/facade.js";

/** Cap on the reason an operator may attach to a denied approval. */
const MAX_DENY_REASON_CHARS = 500;

// Plain node:http — the API is a handful of JSON routes plus one SSE stream; a framework would be
// the largest dependency in the app for no gain.
//
// CORS: the origin is reflected and no credentials flag is set. That is deliberate, not lax — auth
// is a short-TTL signed delegated token in the Authorization header (never a cookie), so a foreign
// page gains nothing from being allowed to *send* a request it has no token for. Reflecting the
// origin is what lets Shell (a different origin) call the gateway directly, per the phase-2 CORS
// obligation in the plan.

const MAX_BODY_BYTES = 64 * 1024;

export function createGatewayServer(
  manager: SessionManager,
  adapter: HarnessAdapter,
  settings: SettingsStore | null = null,
  providers: ProviderDirectory | null = null,
  proxy: McpProxy | null = null,
  facade: McpFacade | null = null,
  connections: ConnectionService | null = null,
  internal?: (request: IncomingMessage, response: ServerResponse) => Promise<boolean>,
): Server & { stopTaskDispatch: () => Promise<void> } {
  const tasks = new TaskService(manager);
  const handoffs = new HandoffStore(manager, settings, providers);
  const eventStreams = new EventStreamTransport(manager, Date.now, connections);
  const translations = connections && settings ? new TranslationService(connections, settings) : null;
  const recovered = handoffs.sweep().then(() => manager.recoverWorkerRuns()).then(() => manager.recoverMcpApprovals()).catch(error => {
    // A transient directory/storage failure is retried by the periodic sweep. Keep unrelated
    // endpoints available and attach the handler immediately, before the first request arrives.
    console.error("[handoff] startup recovery failed", error);
  });
  const timer = setInterval(() => { void handoffs.sweep().catch(error => console.error("[handoff] cleanup failed", error)); }, 60_000);
  timer.unref();
  const server = createServer((request, response) => {
    void recovered.then(async () => { if (await internal?.(request, response)) return; return route(request, response, manager, adapter, settings, providers, proxy, facade, connections, handoffs, translations, eventStreams, tasks); }).catch((error) => {
      if (response.destroyed) return;
      if (error instanceof ProviderError) { sendJson(response, error.status, { code: error.code, message: error.message }); return; }
      if (error instanceof SessionBusyError) {
        sendJson(response, 409, { code: "session_busy", message: error.message });
        return;
      }
      if (error instanceof AppContextError || error instanceof ConnectionError || error instanceof WorkerError || error instanceof WorkerApiError) {
        sendJson(response, error.status, { code: error.code, message: error.message });
        return;
      }
      if (error instanceof SessionNotFoundError) {
        sendJson(response, 404, { code: "session_not_found", message: error.message });
        return;
      }
      if (error instanceof PayloadTooLargeError) {
        sendJson(response, 413, { code: "payload_too_large", message: error.message });
        return;
      }
      console.error("[server] unhandled", error);
      if (!response.headersSent) {
        sendJson(response, 500, { code: "internal_error", message: "Unexpected gateway error." });
      } else {
        response.end();
      }
    });
  });
  eventStreams.attach(server);
  const taskServer = Object.assign(server, { stopTaskDispatch: () => tasks.close() });
  const close = server.close.bind(server);
  server.close = ((callback?: (error?: Error) => void) => { void tasks.close(); eventStreams.close(); return close(callback); }) as typeof server.close;
  server.on("close", () => { clearInterval(timer); tasks.close(); });
  return taskServer;
}

class PayloadTooLargeError extends Error {}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  manager: SessionManager,
  adapter: HarnessAdapter,
  settings: SettingsStore | null,
  providers: ProviderDirectory | null,
  proxy: McpProxy | null,
  facade: McpFacade | null,
  connections: ConnectionService | null,
  handoffs: HandoffStore,
  translations: TranslationService | null,
  eventStreams: EventStreamTransport,
  tasks: TaskService,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://gateway.local");
  const method = request.method ?? "GET";
  applyCors(request, response);

  if (method === "OPTIONS") {
    response.writeHead(204).end();
    return;
  }

  // This surface accepts only its exact Core provider credential, never operator cookies.
  if (await translationRoute(request, response, url, translations)) return;

  // Outside /api and ahead of the operator gate, like the proxy below and for the same kind of
  // reason: an external agent client authenticates with a scoped access token of its own, which
  // Core introspects, rather than with an operator's delegated token (facade/facade.ts).
  if (facade && (await facade.handle(request, response, url.pathname))) {
    return;
  }

  // Before the operator gate, and deliberately outside /api: the per-session MCP proxy authenticates
  // with a session key held by the harness, not with an operator's delegated token, and it is bound
  // to loopback. Its own handler enforces both (mcp/proxy.ts).
  if (await manager.developmentMcp.handle(request, response, url.pathname)) return;

  if (proxy && (await proxy.handle(request, response, url.pathname))) {
    return;
  }

  if (method === "GET" && url.pathname === "/healthz") {
    const health = connections ? await connections.summary() : { name: adapter.name, capabilities: { ...adapter.capabilities, appContext: true }, ...await adapter.probe() };
    sendJson(response, 200, {
      status: "ok",
      harness: health,
    });
    return;
  }

  if (url.pathname.startsWith("/api/hosty/ui/")) {
    const token = readAppCredential(request);
    const session = await resolveAppSession(token);
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    const body = method === "POST" ? JSON.stringify(await readJson(request)) : undefined;
    const incoming = new Request(url, { method, headers, body });
    const result = await createHostyUiResponse(incoming, { session, token }, { administratorOnly: true, appId: process.env.HOSTY_APP_ID ?? "hosty.harness" });
    response.setHeader("Cache-Control", "no-store");
    sendJson(response, result.status, await result.json());
    return;
  }

  if (method === "GET" && url.pathname === "/api/hosty/session") {
    const [session, recovery] = await Promise.all([
      resolveAppSession(readAppCredential(request)), getAppRecoveryParams(),
    ]);
    const credential = readAppCredential(request);
    if (session.status === "active" && session.identity.hostRole === "host.admin" && credential) {
      // Refresh closed conversation views too, without making validated identity wait on
      // another conversation's execution queue. Core still checks authority on each tool call.
      manager.scheduleActorCredentialRefresh(session.identity.userId, credential);
    }
    const result = await createHostySessionResponse(session, recovery, { administratorOnly: true });
    response.setHeader("Cache-Control", "no-store");
    sendJson(response, result.status, await result.json());
    return;
  }

  if (method === "GET" && url.pathname === "/api/hosty/permissions") {
    const session = await resolveAppSession(readAppCredential(request));
    response.setHeader("Cache-Control", "no-store");
    try {
      sendJson(response, 200, await readOwnPermissionNotice(session.status === "active" ? session.identity.hostRole : null));
    } catch { sendJson(response, 503, { message: "Permission state is unavailable." }); }
    return;
  }

  if (method === "GET" && url.pathname === "/api/auth/identity") {
    response.setHeader("Cache-Control", "no-store");
    const session = await resolveAppSession(readAppCredential(request));
    sendJson(response, 200, { status: session.status === "active" && session.identity.hostRole !== "host.admin" ? "forbidden" : session.status,
      ...(session.status === "active" ? { userId: session.identity.userId, activeUntil: session.identity.activeUntil, activityRequired: session.identity.activityRequired, continuity: session.identity.continuity } : {}),
      ...(session.status !== "active" && session.error ? { error: session.error } : {}),
      recovery: await getAppRecoveryParams() });
    return;
  }

  // The static page fetches its protected data through the admin-gated app API. Core delivers the
  // one-time code to this app's navigation or its own popup; Shell does not carry the code. This
  // endpoint exchanges it and revalidates the grant for Harness before setting the app cookie.
  if (method === "POST" && (url.pathname === "/api/app-code" || url.pathname === "/api/auth/app-code")) {
    response.setHeader("Cache-Control", "no-store");
    if (!isSameOriginRequest(request)) {
      // The page calls this with a relative URL, so a legitimate exchange is always same-origin.
      // Refusing anything else closes login CSRF: a cross-site post of *its own* valid code would
      // otherwise hand this browser a session belonging to whoever minted it.
      sendJson(response, 403, {
        code: "cross_site_request_blocked",
        message: "This endpoint only accepts requests from the gateway's own pages.",
      });
      return;
    }

    const body = await readJson(request);
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (!code) {
      sendJson(response, 422, { code: "app_auth_code_required", message: "A Hosty app authorization code is required." });
      return;
    }
    const codeVerifier = body.codeVerifier;
    if (!isValidCodeVerifier(codeVerifier)) {
      sendJson(response, 400, { code: "app_auth_proof_required", message: "A valid Hosty sign-in proof is required." });
      return;
    }

    const forwardedProto = request.headers["x-forwarded-proto"];
    const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
    const exchange = await exchangeLaunchCode(code, codeVerifier, (proto ?? "").split(",")[0]?.trim() === "https");
    if (!exchange.ok) {
      sendJson(response, exchange.status, { code: exchange.code, message: exchange.message });
      return;
    }

    response.setHeader("set-cookie", exchange.setCookie);
    sendJson(response, 200, { accessToken: exchange.accessToken, expiresInSeconds: exchange.expiresInSeconds, activeUntil: exchange.activeUntil });
    return;
  }

  // Everything that is not the API is the settings page's static export. Served without a
  // credential on purpose: the bundle carries no data, and its first act is to authenticate.
  if (!url.pathname.startsWith("/api/")) {
    if (method === "GET" && (await serveStaticSite(url.pathname, response))) {
      return;
    }

    sendJson(response, 404, { code: "not_found", message: "Unknown route." });
    return;
  }

  // Task provider credentials are valid only on their declared category surface. Cookie writes
  // retain the same origin check as all other operator APIs.
  if (url.pathname.startsWith("/api/tasks/v1") || url.pathname.startsWith("/api/task-executor/v1")) {
    const bearer = readBearer(request);
    if (!bearer && method !== "GET" && method !== "HEAD" && !isSameOriginRequest(request)) {
      sendJson(response, 403, { code: "cross_site_request_blocked", message: "Use the Harness origin for cookie-authenticated changes." }); return;
    }
    if (await tasks.route(request, response, url, () => readJson(request))) return;
  }

  // Everything under /api is operator surface: admin-only by decision, no anonymous reads. Two
  // credential shapes: the browser presents its app grant; existing direct clients may present
  // a delegated token. Both must resolve to an administrator.
  let invocation: ProviderInvocation | null = null;
  const providerBearer = readBearer(request);
  if (providerBearer?.startsWith("hosty_provider.") && (url.pathname === "/api/assistant/v1/handoffs" || url.pathname.startsWith("/api/assistant/v1/handoffs/"))) {
    invocation = await new ProviderClient().validate(providerBearer, "assistant");
    if (!invocation.userId || invocation.hostRole !== "host.admin") {
      sendJson(response, 403, { code: "admin_required", message: "This assistant accepts administrator requests only." }); return;
    }
  }
  const consumer = invocation ? `${invocation.callerAppId}:${invocation.callerInstallation}` : undefined;
  const actor = invocation ? { userId: invocation.userId!, via: "provider-token" as const, expiresAtSeconds: null }
    : await resolveAdminActor(request);
  if (!actor) {
    sendJson(response, 401, {
      code: "unauthorized",
      message: "A Host administrator session or delegated token is required.",
    });
    return;
  }

  // An app session travels as a cookie the browser attaches on its own, so a state-changing call
  // made with one has to prove where it came from; a delegated token is carried deliberately and
  // needs no such proof. Reads are left alone — a cross-site caller can cause them but cannot read
  // the reply, since no response here grants credentialed CORS access.
  //
  // Checked here as a group rather than per route: the failure mode of the per-route style is the
  // route someone adds later and forgets.
  if (actor.via === "app-session" && method !== "GET" && method !== "HEAD" && !isSameOriginRequest(request)) {
    sendJson(response, 403, {
      code: "cross_site_request_blocked",
      message: "A session cookie may only change state from the gateway's own pages.",
    });
    return;
  }

  if (url.pathname === "/api/preferences/prompt-suggestions" && (method === "GET" || method === "PUT")) {
    if (actor.via !== "app-session") throw new AppContextError(403, "app_session_required", "Open Harness through Core to manage your preferences.");
    response.setHeader("Cache-Control", "no-store");
    sendJson(response, 200, method === "GET" ? await manager.suggestionPreference(actor.userId)
      : await manager.setSuggestionPreference(actor.userId, await readJson(request))); return;
  }

  if (method === "POST" && url.pathname === "/api/event-stream-tickets") {
    if (actor.via === "provider-token") throw new AppContextError(403, "admin_session_required", "Open Harness through Core to read events.");
    response.setHeader("Cache-Control", "no-store");
    sendJson(response, 200, await eventStreams.issue(await readJson(request), request, actor)); return;
  }

  if (isSkillManagementRoute(method, url.pathname)) {
    if (actor.via !== "app-session") throw new AppContextError(403, "app_session_required", "Open Harness through Core to manage skills.");
    response.setHeader("cache-control", "no-store");
    const result = await manageSkills(method, url, readAppCredential(request), method === "POST" ? await readJson(request) : undefined);
    sendJson(response, result.status, result.body); return;
  }

  if (isSourceConnectionRoute(method, url.pathname)) {
    response.setHeader("cache-control", "no-store");
    if (actor.via !== "app-session") {
      sendJson(response, 403, { code: "app_session_required", message: "Sign in to Harness through Core to manage source providers." }); return;
    }
    const result = await requestSourceConnection(method, url.pathname, readAppCredential(request),
      method === "POST" || method === "PUT" ? await readJson(request) : undefined);
    sendJson(response, result.status, result.body); return;
  }

  if (isWorkspaceAccessReviewRoute(method, url.pathname)) {
    response.setHeader("cache-control", "no-store");
    if (actor.via !== "app-session") {
      sendJson(response, 403, { code: "app_session_required", message: "Sign in to Harness through Core to review workspace access." }); return;
    }
    const result = await requestWorkspaceAccessReview(method, url.pathname, readAppCredential(request), method === "POST" ? await readJson(request) : undefined);
    sendJson(response, result.status, result.body); return;
  }

  if (await speechRoute(request, response, url)) return;

  if (url.pathname === "/api/settings/translation" && translations && method === "GET") {
    sendJson(response, 200, await translations.configuration()); return;
  }
  const translationSetting = url.pathname.match(/^\/api\/settings\/translation\/(codex|claude)$/);
  if (translationSetting && translations && method === "PUT" && isTranslationKind(translationSetting[1]!)) {
    const body = await readJson(request);
    sendJson(response, 200, await translations.configure(translationSetting[1], body.connectionId, body.model)); return;
  }

  if (url.pathname === "/api/assistant/v1/handoffs" && method === "POST") {
    const prepared = await handoffs.prepare(actor.userId, await readJson(request), consumer);
    sendJson(response, prepared.created ? 201 : 200, prepared.value); return;
  }
  const handoff = url.pathname.match(/^\/api\/assistant\/v1\/handoffs\/([^/]+)(?:\/(finalize|attachments)(?:\/([^/]+))?)?$/);
  if (handoff) {
    const [, id, action, attachmentId] = handoff;
    if (!action && method === "GET") { sendJson(response, 200, await handoffs.status(actor.userId, id!, consumer)); return; }
    if (!action && method === "DELETE") { sendJson(response, 200, await handoffs.cancel(actor.userId, id!, consumer)); return; }
    if (action === "finalize" && method === "POST") {
      const body = await readJson(request);
      sendJson(response, 200, await handoffs.finalize(actor.userId, id!, body.attachmentIds, invocation ? undefined : await delegationCredential(request, false), consumer,
        actor.via === "app-session" ? readAppCredential(request) ?? undefined : undefined)); return;
    }
    if (action === "attachments" && attachmentId && method === "PUT") {
      const uploaded = await handoffs.upload(actor.userId, id!, attachmentId, url.searchParams.get("name") ?? "", request.headers["content-type"] ?? "application/octet-stream", request, consumer);
      sendJson(response, uploaded.created ? 201 : 200, uploaded.value); return;
    }
    sendJson(response, 405, { code: "method_not_allowed", message: "Unsupported handoff operation." }); return;
  }

  // The display name behind each MCP server name. A server name is the app id with dots replaced and
  // a hash appended when that changed it — unique on the wire, and unreadable in a transcript, where
  // an operator sees `com-haas-media-server-f9a077 · add_torrent`. The wire name cannot change: the
  // client builds `mcp__<server>__<tool>` from it and the grant set is keyed on it. So the id stays
  // and the label is translated, here, where the roster already is.
  if (url.pathname === "/api/runtime" && method === "GET") { sendJson(response, 200, await manager.runtimeStatus()); return; }
  if (method === "GET" && url.pathname === "/api/apps") {
    const discovered = providers ? await providers.read() : null;
    const core = providers?.core() ?? null;
    const apps = [
      ...(core ? [{ server: serverName(core.appId), displayName: core.displayName }] : []),
      ...(discovered?.providers ?? []).map((provider) => ({
        server: serverName(provider.appId),
        displayName: provider.displayName,
      })),
    ];
    // An empty list is honest when discovery failed: every label then falls back to the wire name,
    // which is what the transcript showed before this route existed.
    sendJson(response, 200, { apps });
    return;
  }

  if (method === "GET" && url.pathname === "/api/health") {
    const healthSession = url.searchParams.get("sessionId");
    if (healthSession && (await manager.getSession(healthSession))?.createdBy !== actor.userId) {
      sendJson(response, 404, { code: "session_not_found", message: "Session not found." }); return;
    }
    const health = url.searchParams.get("sessionId") ? await manager.sessionHealth(url.searchParams.get("sessionId")!)
      : connections ? await connections.summary() : { name: adapter.name, capabilities: { ...adapter.capabilities, appContext: true }, ...await adapter.probe() };
    // Capabilities travel with health because the client needs them to decide what to render: a
    // harness that cannot ask questions must not get a question card, and one that cannot be
    // reconfigured live must not be described as applying a toggle immediately.
    sendJson(response, 200, {
      status: "ok",
      harness: health,
    });
    return;
  }

  if (url.pathname.startsWith("/api/profiles")) response.setHeader("cache-control", "no-store");
  if (manager.profiles && url.pathname === "/api/profiles") {
    if (method === "GET") { sendJson(response, 200, await manager.profiles.read()); return; }
    if (method === "POST") {
      const body = await readJson(request);
      const config = await manager.validateProfile(body.profile);
      sendJson(response, 201, await manager.profiles.save(config, body.expectedRevision)); return;
    }
  }
  if (manager.profiles && url.pathname === "/api/profiles/default" && method === "PUT") {
    const body = await readJson(request);
    sendJson(response, 200, await manager.profiles.setDefault(body.profileId, body.expectedRevision)); return;
  }
  const profileMatch = url.pathname.match(/^\/api\/profiles\/([a-f0-9-]{36})$/);
  if (manager.profiles && profileMatch && (method === "PUT" || method === "DELETE")) {
    const body = await readJson(request);
    if (method === "DELETE") sendJson(response, 200, await manager.profiles.remove(profileMatch[1]!, body.expectedRevision));
    else sendJson(response, 200, await manager.profiles.save(await manager.validateProfile(body.profile), body.expectedRevision, profileMatch[1]!));
    return;
  }
  const connectionUsage = url.pathname.match(/^\/api\/connections\/([a-zA-Z0-9-]+)\/usage$/);
  if (connections && connectionUsage && method === "GET") {
    sendJson(response, 200, await connections.usage(connectionUsage[1]!, url.searchParams.get("refresh") === "true")); return;
  }

  const connectionModels = url.pathname.match(/^\/api\/connections\/([a-zA-Z0-9-]+)\/models$/);
  if (connections && connectionModels && method === "GET") {
    sendJson(response, 200, await connections.models(connectionModels[1]!)); return;
  }

  if (connections && url.pathname === "/api/connections") {
    if (method === "GET") { sendJson(response, 200, await connections.list()); return; }
    if (method === "POST") { sendJson(response, 201, await connections.update(await readJson(request))); return; }
  }
  if (connections && url.pathname === "/api/connections/default" && method === "PUT") {
    await connections.setDefault((await readJson(request)).connectionId); sendJson(response, 200, await connections.list()); return;
  }
  const loginMatch = url.pathname.match(/^\/api\/provider-logins\/([a-zA-Z0-9-]+)$/);
  if (connections && loginMatch) {
    if (method === "DELETE") await connections.cancelLogin(loginMatch[1]!);
    if (method === "GET" || method === "DELETE") { sendJson(response, 200, await connections.fetchLogin(loginMatch[1]!)); return; }
  }
  const connectionMatch = url.pathname.match(/^\/api\/connections\/([a-zA-Z0-9-]+)(\/test|\/login|\/prepare-docker)?$/);
  if (connections && connectionMatch) {
    const id = connectionMatch[1]!; const action = connectionMatch[2] ?? "";
    if (method !== "GET" && action !== "/test") await manager.assertWorkerProviderInactive(id);
    if (action === "/prepare-docker" && method === "POST") {
      await manager.assertWorkerProviderInactive(id);
      await connections.prepareDockerAuthorization(id);
      sendJson(response, 200, { ready: true }); return;
    }
    if (action === "/test" && method === "POST") { sendJson(response, 200, await connections.health(await connections.binding(id))); return; }
    if (action === "/login" && method === "POST") { sendJson(response, 200, await connections.startLogin(id)); return; }
    if (!action && method === "PUT") { sendJson(response, 200, await connections.update(await readJson(request), id)); return; }
    if (!action && method === "DELETE") { await connections.remove(id); sendJson(response, 200, { removed: true }); return; }
  }

  if (url.pathname === "/api/settings/mcp/review" && providers && method === "POST") {
    const credential = await delegationCredential(request);
    if (!credential) throw new AppContextError(401, "credentials_required", "Refresh your Hosty session.");
    const body = await readJson(request);
    if (typeof body.requestId !== "string" || typeof body.revision !== "string" || !Array.isArray(body.targets))
      throw new AppContextError(400, "mcp_change_invalid", "Invalid MCP access changes.");
    sendJson(response, 200, await providers.accessReview(credential, { requestId: body.requestId, revision: body.revision, targets: body.targets })); return;
  }
  const accessStatus = url.pathname.match(/^\/api\/settings\/mcp\/review\/([a-f0-9]{48})$/);
  if (accessStatus && providers && method === "GET") {
    const credential = await delegationCredential(request);
    if (!credential) throw new AppContextError(401, "credentials_required", "Refresh your Hosty session.");
    sendJson(response, 200, await providers.reviewRequest(credential, `/${accessStatus[1]}`)); return;
  }

  if (url.pathname === "/api/settings/mcp/preferences" && settings && providers && method === "PUT") {
    const body = await readJson(request);
    const current = await settings.read();
    if (body.revision !== mcpPreferencesRevision(current)) throw new AppContextError(409, "settings_changed", "Invocation preferences changed. Reload before saving.");
    if (!Array.isArray(body.resetProviders) || body.resetProviders.some(p => typeof p !== "string"))
      throw new AppContextError(400, "mcp_preferences_invalid", "Invalid MCP preferences.");
    const removeRules = body.removeRules ?? [];
    if (!Array.isArray(removeRules) || removeRules.length > 2000 || removeRules.some(key => typeof key !== "string" || !Object.hasOwn(current.mcpToolRules ?? {}, key)))
      throw new AppContextError(400, "mcp_preferences_invalid", "Invalid tool exceptions.");
    const directory = await providers.read();
    const migratedDenials = new Set([providers.core(), ...(directory?.providers ?? [])].filter(p => p != null)
      .flatMap(p => (p.deniedTools ?? []).map(tool => JSON.stringify([p.appId, tool]))));
    const prepared = manager.mcpPolicy.preparePreferences(body.defaults as never, body.rules as never);
    if (body.resetProviders.some(p => !Object.hasOwn(prepared.defaults, p)))
      throw new AppContextError(400, "mcp_preferences_invalid", "A provider reset needs its reviewed default.");
    const resetProviders = body.resetProviders as string[];

    await settings.transform(latest => {
      if (body.revision !== mcpPreferencesRevision(latest)) throw new AppContextError(409, "settings_changed", "Invocation preferences changed. Reload before saving.");
      const rules = { ...latest.mcpToolRules };
      for (const key of Object.keys(rules)) if (rules[key]?.mode === "disabled" ? migratedDenials.has(key) || JSON.parse(key)[0] === "hosty:development" && removeRules.includes(key) : resetProviders.includes(JSON.parse(key)[0]) || removeRules.includes(key)) delete rules[key];
      return { mcpDefaults: { ...latest.mcpDefaults, ...prepared.defaults }, mcpToolRules: { ...rules, ...prepared.rules } };
    });
    sendJson(response, 200, { revision: mcpPreferencesRevision(await settings.read()) }); return;
  }

  if (url.pathname === "/api/settings/tools" && settings && method === "GET") {
    const credential = await delegationCredential(request);
    if (!credential) throw new AppContextError(401, "credentials_required", "Refresh your Hosty session.");
    const unavailable = await manager.discoverMcpTools(credential);
    sendJson(response, 200, { unavailable, catalogs: manager.mcpPolicy.snapshot(), settings: await settings.read() }); return;
  }

  if (url.pathname === "/api/settings" && settings && (method === "GET" || method === "PUT")) {
    if (method === "GET") await migrateSkillSelection(settings).catch(() => {});
    if (method === "PUT") {
      const body = await readJson(request);
      if (manager.profiles && body.skillIds !== undefined) throw new AppContextError(409, "skill_selection_moved", "Choose skills in Agent profiles or supply an explicit session selection.");
      if (body.skillIds !== undefined && !validSkillIds(body.skillIds)) throw new AppContextError(400, "skills_invalid", "Choose stable skill IDs from the Core catalog.");
      if (body.retention !== undefined && !validRetention(body.retention)) {
        sendJson(response, 400, { code: "retention_invalid", message: "Choose Off or whole days from 1 to 3650 for both retention policies." }); return;
      }
      if (body.workflowPrompt !== undefined && (typeof body.workflowPrompt !== "string" || body.workflowPrompt.length > MAX_SYSTEM_PROMPT_CHARS)) {
        sendJson(response, 400, { code: "workflow_prompt_invalid", message: `Workflow instructions must be text up to ${MAX_SYSTEM_PROMPT_CHARS} characters.` }); return;
      }
      if (body.systemPrompt !== undefined && typeof body.systemPrompt !== "string") {
        sendJson(response, 400, {
          code: "system_prompt_invalid",
          message: "systemPrompt must be a string.",
        });
        return;
      }
      if (typeof body.systemPrompt === "string" && body.systemPrompt.length > MAX_SYSTEM_PROMPT_CHARS) {
        sendJson(response, 400, {
          code: "system_prompt_too_long",
          message: `systemPrompt must be at most ${MAX_SYSTEM_PROMPT_CHARS} characters.`,
        });
        return;
      }
      if (body.mcpProviders !== undefined || body.mcpSkillDigests !== undefined) {
        sendJson(response, 409, { code: "agent_policy_moved", message: "Manage MCP access through Core review in Harness settings." });
        return;
      }
      if (body.mcpAutoAllow !== undefined && !isBooleanRecord(body.mcpAutoAllow)) {
        sendJson(response, 400, {
          code: "mcp_auto_allow_invalid",
          message: "mcpAutoAllow must be an object of appId -> boolean.",
        });
        return;
      }
      if (body.immediateHandoffs !== undefined && typeof body.immediateHandoffs !== "boolean") {
        sendJson(response, 400, { code: "handoff_setting_invalid", message: "immediateHandoffs must be a boolean." }); return;
      }
      if (body.mcpToolRules !== undefined) {
        try { await manager.mcpPolicy.update(body.mcpToolRules as Record<string, import("./mcp/policy.js").ToolRule>); }
        catch (error) { sendJson(response, 409, { code: "tool_policy_changed", message: error instanceof Error ? error.message : "Refresh the tool catalog." }); return; }
      }
      if (body.executionMode !== undefined) await manager.setExecutionMode(body.executionMode);
      await settings.update({
        skillIds: validSkillIds(body.skillIds) ? body.skillIds : undefined,
        workflowPrompt: typeof body.workflowPrompt === "string" ? body.workflowPrompt : undefined,
        retention: validRetention(body.retention) ? body.retention : undefined,
        immediateHandoffs: typeof body.immediateHandoffs === "boolean" ? body.immediateHandoffs : undefined,
        systemPrompt: typeof body.systemPrompt === "string" ? body.systemPrompt : undefined,
        mcpAutoAllow: isBooleanRecord(body.mcpAutoAllow) ? body.mcpAutoAllow : undefined,
      });
      if (isBooleanRecord(body.mcpAutoAllow)) {
        // Immediately, not at the next timer tick — the page says "applied to running sessions", and
        // for a *revoked* grant that has to be true the moment the operator sees it.
        await manager.applyProviderPolicy();
        // The facade caches an assembled catalog per user for a few seconds. That window is
        // harmless for access (every call re-mints, so a stale catalog can offer a name but never
        // make a refused call succeed) and wrong for *policy*: a provider the operator just turned
        // off should stop being offered now, not shortly.
        facade?.invalidate();
      }
    }

    // Discovery runs on read so the list follows the fleet without the operator reloading anything.
    // A null result means Core could not be asked — reported as such rather than as an empty list,
    // which would read as "no app declares MCP" and be a different statement.
    const discovered = providers ? await providers.read() : null;
    if (discovered) {
      await settings.prune(discovered.installedAppIds);
    }
    // Core is governed by the same host offer policy as app targets.
    const core = providers?.core() ?? null;

    const current = await settings.read();
    // Legacy field remains empty; instructions and review are exposed together below.
    const pendingSkills: never[] = [];
    // Capabilities ride along so the page can say what a change actually does on this harness
    // instead of one wording that is false on one of them.
    sendJson(response, 200, {
      settings: { ...current, mcpProviders: Object.fromEntries([...(core ? [core] : []), ...(discovered?.providers ?? [])].map(provider => [provider.appId, provider.offered === true])) },
      mcpRevision: mcpPreferencesRevision(current),
      accessRevision: discovered?.revision,
      toolCatalogs: manager.mcpPolicy.snapshot(),
      mcpReviewBaseUrl: process.env.HOSTY_CORE_PUBLIC_ORIGIN
        ? `${process.env.HOSTY_CORE_PUBLIC_ORIGIN.replace(/\/$/, "")}/install/agents/${encodeURIComponent(process.env.HOSTY_APP_ID ?? "hosty.harness")}` : null,
      instructions: [],
      pendingSkills,
      providers: [...(core ? [core] : []), ...(discovered?.providers ?? [])],
      discovery: discovered ? "ok" : "unavailable",
      harness: connections ? { name: "Selected chat provider", capabilities: { autoAllow: true, liveReconfigure: false } } : { name: adapter.name, capabilities: adapter.capabilities },
      agentConnections: Boolean(connections),
      defaults: { workflowPrompt: DEFAULT_WORKFLOW_PROMPT },
      limits: { systemPromptChars: MAX_SYSTEM_PROMPT_CHARS },
    });
    return;
  }

  if (url.pathname === "/api/session-apps" && method === "GET") {
    const apps = await readContextApps(providers);
    if (url.searchParams.has("ids")) {
      const ids = parseAppIds(url.searchParams.get("ids")?.split(",") ?? []);
      sendJson(response, 200, { apps: ids.map(id => apps.find(app => app.id === id) ?? { id, displayName: id, available: false }), nextOffset: null });
      return;
    }
    const search = (url.searchParams.get("search") ?? "").slice(0, 200).toLowerCase();
    const offset = Number(url.searchParams.get("offset") ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new AppContextError(400, "offset_invalid", "Invalid app list offset.");
    const filtered = apps.filter(app => `${app.id} ${app.displayName}`.toLowerCase().includes(search));
    sendJson(response, 200, { apps: filtered.slice(offset, offset + 100), nextOffset: offset + 100 < filtered.length ? offset + 100 : null });
    return;
  }

  if (url.pathname === "/api/sessions" && method === "POST") {
    const body = await readJson(request);
    const record = await manager.createSession({
      profileId: body.profileId,
      profileRevision: body.profileRevision,
      skillIds: body.skillIds,
      title: typeof body.title === "string" ? body.title : undefined,
      context: isStringRecord(body.context) ? body.context : undefined,
      createdBy: actor.userId,
      appIds: body.appIds,
      clientRequestId: body.clientRequestId,
      connectionId: body.connectionId,
    });
    sendJson(response, 200, record);
    return;
  }

  if (url.pathname === "/api/sessions" && method === "GET") {
    const records = (await manager.listSessions()).filter(record => record.createdBy === actor.userId);
    const roster = records.some(record => record.appIds?.length)
      ? await readContextApps(providers).catch(() => null) : [];
    sendJson(response, 200, { sessions: records.map(record => ({
      ...record,
      contextApps: roster === null ? undefined : (record.appIds ?? []).map(id => {
        const app = roster.find(app => app.id === id);
        return app ? { id, displayName: app.displayName, available: app.available, icon: app.icon, iconUrl: app.iconUrl }
          : { id, displayName: id, available: false };
      }),
      appContext: contextFromRoster(roster ?? [], record.appIds ?? [], record.appContextRevision ?? 0,
        roster === null && record.appIds?.length ? "unavailable" : "ok"),
    })) });
    return;
  }

  if (url.pathname === "/api/workspace-sessions" && method === "POST") {
    const credential = actor.via === "app-session" ? readAppCredential(request) : null;
    if (!credential) throw new AppContextError(401, "reauth_required", "Open Harness through Core to join a workspace.");
    const body = await readJson(request);
    sendJson(response, 200, await manager.newWorkspaceSession(actor.userId, credential, {
      workspaceId: body.workspaceId as string, requestId: body.requestId as string, expectedRevision: body.expectedRevision as number })); return;
  }

  if (url.pathname === "/api/building-sessions" && method === "POST") {
    const credential = actor.via === "app-session" ? readAppCredential(request) : null;
    if (!credential) throw new AppContextError(401, "reauth_required", "Open Harness through Core to continue building.");
    const body = await readJson(request);
    sendJson(response, 200, await manager.newBuildingSession(actor.userId, credential, {
      appId: body.appId as string, requestId: body.requestId as string, expectedLocalHead: body.expectedLocalHead as string }));
    return;
  }

  if (url.pathname === "/api/development-workspaces/events" && method === "GET") {
    const credential = actor.via === "app-session" ? readAppCredential(request) : null;
    if (!credential) throw new AppContextError(401, "reauth_required", "Open Harness through Core to inspect workspaces.");
    const abort = new AbortController();
    const closed = () => abort.abort(); response.once("close", closed);
    const timeout = setTimeout(closed, APP_SESSION_STREAM_SECONDS * 1000);
    try {
      const upstream = await manager.workspaceEvents(credential, abort.signal);
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store, no-transform", "x-accel-buffering": "no" });
      await pipeline(upstream.body!, response, { signal: abort.signal });
    } catch (error) { if (!response.headersSent && !abort.signal.aborted) throw error; response.destroy(); }
    finally { clearTimeout(timeout); response.off("close", closed); abort.abort(); }
    return;
  }

  if (workspaceApplicationsRoute(method, url.pathname)) {
    const credential = actor.via === "app-session" ? readAppCredential(request) : null;
    if (!credential) throw new AppContextError(401, "reauth_required", "Open Harness through Core to manage workspace applications.");
    response.setHeader("cache-control", "no-store");
    sendJson(response, 200, await manager.workspaceApplications(credential, method, url.pathname,
      method === "POST" ? await readJson(request) : undefined)); return;
  }

  const inspection = url.pathname.match(/^\/api\/development-workspaces(\/local-apps|\/[a-f0-9]{64}(?:\/participants(?:\/(?:grant|revoke))?|\/name|\/execution-target(?:\/[a-f0-9-]{36})?|\/discard\/(?:plan|apply|status)|\/activation\/(?:plan|apply|list|status|cancel|resume|return)|\/(?:environments|sandboxes)\/[a-f0-9]{32}\/(?:start|stop|finish|dispose)|\/previews(?:\/[a-f0-9]{32}\/[a-zA-Z0-9._-]+\/(?:checks|run|restart|logs))?|\/worktrees\/[a-f0-9]{64}(?:\/(?:diff|recover-lease|review(?:\/diff)?|reviews\/(?:reply|resolve|comment)))?|\/workflow(?:\/(?:complete|resume|pause|defer|delete|close))?)?)?$/);
  if (inspection && (method === "GET" || method === "POST")) {
    const credential = actor.via === "app-session" ? readAppCredential(request) : null;
    if (!credential) throw new AppContextError(401, "reauth_required", "Open Harness through Core to inspect workspaces.");
    const discard = /\/discard\/(plan|apply|status)$/.exec(inspection[1] ?? "");
    if (discard && method !== (discard[1] === "apply" ? "POST" : "GET"))
      throw new AppContextError(405, "workspace_method_invalid", "Removal review and status require GET; removal apply requires POST.");
    if (method === "POST" && !/\/(?:participants\/(?:grant|revoke)|name|execution-target|discard\/apply|activation\/(?:plan|apply|list|status|cancel|resume|return)|(?:environments|sandboxes)\/[a-f0-9]{32}\/(?:start|stop|finish|dispose)|worktrees\/[a-f0-9]{64}\/(?:recover-lease|reviews\/(?:reply|resolve|comment))|workflow\/(?:complete|resume|pause|defer|delete|close)|previews\/[a-f0-9]{32}\/[a-zA-Z0-9._-]+\/(?:checks|run|restart|logs))$/.test(inspection[1] ?? ""))
      throw new AppContextError(400, "workspace_action_invalid", "Choose a workspace lifecycle action.");
    if (method === "GET" && /\/reviews\/(?:reply|resolve|comment)$/.test(inspection[1] ?? ""))
      throw new AppContextError(405, "workspace_method_invalid", "Review actions require POST.");
    response.setHeader("cache-control", "no-store");
    const inspected = await manager.inspectWorkspaces(credential, (inspection[1] ?? "") + url.search,
      method === "POST" ? await readJson(request) : undefined, actor.userId);
    // Drafts and pending browser actions belong to the authenticated operator, not the workspace owner.
    const reviewInventory = method === "GET" && /\/worktrees\/[a-f0-9]{64}\/review$/.test(inspection[1] ?? "");
    sendJson(response, 200, reviewInventory && inspected && typeof inspected === "object"
      ? { ...inspected, viewerId: actor.userId } : inspected); return;
  }

  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([a-zA-Z0-9-]+)(\/.*)?$/);
  if (!sessionMatch) {
    sendJson(response, 404, { code: "not_found", message: "Unknown route." });
    return;
  }

  const sessionId = sessionMatch[1]!;
  const ownedSession = await manager.getSession(sessionId);
  if (!ownedSession || ownedSession.createdBy !== actor.userId) {
    sendJson(response, 404, { code: "session_not_found", message: "Session not found." }); return;
  }
  if (sessionMatch[2] === "/profile" && method === "PUT") {
    sendJson(response, 200, await manager.setProfile(sessionId, await readJson(request))); return;
  }
  if (sessionMatch[2] === "/workspaces" && method === "POST") {
    const body = await readJson(request, 256 * 1024);
    const action = body.action;
    if (typeof action !== "string") throw new AppContextError(400, "workspace_action_invalid", "Workspace action is required.");
    sendJson(response, 200, await manager.workspaceAction(sessionId, action as import("./sessions/development.js").DevelopmentAction,
      action.startsWith("context-") ? Object.fromEntries(Object.entries(body).filter(([key]) => key !== "action")) : body,
      (actor.via === "app-session" ? readAppCredential(request) : readBearer(request)) ?? undefined, actor.userId)); return;
  }

  const rest = sessionMatch[2] ?? "";
  if (rest === "/app-creations/dispatch" && method === "POST") {
    const body = await readJson(request, 128 * 1024);
    sendJson(response, 200, await manager.dispatchAppCreation(sessionId, body.requestId, body.prompt, actor.userId,
      await delegationCredential(request, false), actor.via === "app-session" ? readAppCredential(request) ?? undefined : undefined));
    return;
  }
  if (rest === "/autonomy" && method === "PUT") {
    const body = await readJson(request);
    sendJson(response, 200, await manager.setAutonomy(sessionId, body.autonomy, actor.userId)); return;
  }
  if (rest === "/credentials" && method === "POST") {
    const credential = readAppCredential(request);
    if (actor.via !== "app-session" || !credential)
      throw new AppContextError(401, "reauth_required", "Sign in through Core to refresh this conversation.");
    await manager.refreshSessionCredentials(sessionId, actor.userId, credential);
    manager.scheduleActorCredentialRefresh(actor.userId, credential);
    response.setHeader("Cache-Control", "no-store");
    sendJson(response, 200, { updated: true }); return;
  }


  if (rest === "/models" && method === "GET") { sendJson(response, 200, await manager.modelCatalog(sessionId)); return; }
  if (rest === "/model" && method === "PUT") { sendJson(response, 200, await manager.setModel(sessionId, await readJson(request))); return; }

  if (rest === "/provider" && method === "PUT") {
    const body = await readJson(request);
    sendJson(response, 200, await manager.setConnection(sessionId, body.connectionId, body.confirmLegacy === true)); return;
  }

  if ((await manager.getSession(sessionId))?.handoffPending) {
    sendJson(response, 409, { code: "handoff_pending", message: "Finalize or cancel the prepared handoff first." }); return;
  }

  if (rest === "/retention" && method === "POST") {
    const deleted = await manager.sweepRetention(new Date(), sessionId);
    sendJson(response, 200, deleted.includes(sessionId) ? { state: "deleted" } : await manager.sessionRetention(sessionId)); return;
  }
  if (rest === "/retention" && method === "GET") {
    sendJson(response, 200, await manager.sessionRetention(sessionId)); return;
  }

  if (rest === "/apps" && method === "PUT") {
    const body = await readJson(request);
    sendJson(response, 200, await manager.setAppContext(sessionId, body.appIds, body.expectedRevision, actor.userId));
    return;
  }

  if (rest === "" && method === "GET") {
    const record = await manager.getSession(sessionId);
    if (!record) {
      sendJson(response, 404, { code: "session_not_found", message: "Session not found." });
      return;
    }
    // Copy before discovery yields: an SSE update may mutate the live record in the meantime.
    const current = { ...record };
    const appContext = await captureContext(providers, current.appIds ?? [], current.appContextRevision ?? 0, true);
    sendJson(response, 200, { ...current, appContext, ...(connections ? { providerLocked: await manager.sessionProviderLocked(current) } : {}) });
    return;
  }

  if (rest === "" && method === "PATCH") {
    const body = await readJson(request);
    // A string, specifically: `null` would otherwise reach `normalizeTitle` and clear a name the
    // operator chose, which only the empty string is meant to do.
    if (typeof body.title !== "string") {
      sendJson(response, 400, { code: "invalid_request", message: "A title string is required." });
      return;
    }
    const record = await manager.renameSession(sessionId, body.title, actor.via === "app-session" ? readAppCredential(request) ?? undefined : undefined);
    if (!record) {
      sendJson(response, 404, { code: "session_not_found", message: "Session not found." });
      return;
    }
    sendJson(response, 200, record);
    return;
  }

  if (rest === "" && method === "DELETE") {
    const deleted = await manager.deleteSession(sessionId, actor.userId, (actor.via === "app-session" ? readAppCredential(request) : await delegationCredential(request, false)) ?? undefined);
    if (!deleted) {
      sendJson(response, 404, { code: "session_not_found", message: "Session not found." });
      return;
    }
    sendJson(response, 200, { deleted: true });
    return;
  }

  if (rest === "/events" && method === "GET") {
    // An app-session caller carries no token expiry, so the stream is bounded by the session
    // cookie's own maximum instead of running unbounded — the delegated-token panel keeps its exact
    // bound, which is the case this parameter was written for.
    const streamExpiry = actor.expiresAtSeconds ?? Math.floor(Date.now() / 1000) + APP_SESSION_STREAM_SECONDS;
    await streamEvents(request, response, manager, sessionId, url, streamExpiry);
    return;
  }

  const messageReceiptMatch = rest.match(/^\/messages\/([^/]+)$/);
  if (messageReceiptMatch && method === "GET") {
    response.setHeader("Cache-Control", "no-store");
    sendJson(response, 200, await manager.messageReceipt(sessionId, messageReceiptMatch[1], actor.userId)); return;
  }

  if (rest === "/messages" && method === "POST") {
    const body = await readJson(request);
    // Stored names only — the manager resolves each to a workspace path and refuses any that is
    // not one, before the message is written anywhere.
    const attachments = Array.isArray(body.attachments)
      ? body.attachments.filter((name): name is string => typeof name === "string").slice(0, 20)
      : [];
    if (typeof body.text !== "string" || (!body.text.trim() && attachments.length === 0)) {
      sendJson(response, 400, { code: "text_required", message: "Provide text or at least one attachment; text must be a string." });
      return;
    }
    try {
      // The presented token seeds the session's delegation chain; see SessionManager.postMessage.
      const receipt = await manager.postMessage(sessionId, body.text, await delegationCredential(request, false), attachments, { selectionRevision: body.selectionRevision, expectedRevision: body.appContextRevision, withoutDetails: body.withoutAppDetails === true,
        workspaceCredential: actor.via === "app-session" ? readAppCredential(request) : undefined,
        clientRequestId: body.clientRequestId, actorUserId: actor.userId, promptSuggestions: body.promptSuggestions === true });
      response.setHeader("Cache-Control", "no-store");
      sendJson(response, 202, { accepted: true, ...receipt });
      return;
    } catch (error) {
      if (error instanceof Error && /attachments need a workspace/.test(error.message)) {
        // The gateway's configuration, not the request: the same answer the upload route gives.
        sendJson(response, 503, { code: "attachments_unavailable", message: "This gateway has no workspace directory." });
        return;
      }
      if (error instanceof Error && /invalid attachment name|attachment not found/.test(error.message)) {
        sendJson(response, 400, { code: "attachment_invalid", message: error.message });
        return;
      }
      throw error;
    }
  }

  const approvalMatch = rest.match(/^\/approvals\/([a-zA-Z0-9-]+)$/);
  if (approvalMatch && method === "POST") {
    const body = await readJson(request);
    if (body.decision !== "allow" && body.decision !== "deny") {
      sendJson(response, 400, { code: "decision_invalid", message: "decision must be 'allow' or 'deny'." });
      return;
    }
    // The operator's reason for a deny, bounded like every other operator-typed field: it lands in
    // the transcript and in the model's context, and neither wants a pasted log by mistake.
    const reason = typeof body.message === "string" ? body.message.trim().slice(0, MAX_DENY_REASON_CHARS) : "";
    if (reason && !(connections ? (await manager.sessionHealth(sessionId)).capabilities.denyReason : adapter.capabilities.denyReason)) {
      // Refused rather than stored: a reason the harness cannot deliver would sit in the transcript
      // looking delivered. The panel hides the box on such a harness; this covers every other client.
      sendJson(response, 400, {
        code: "deny_reason_unsupported",
        message: "The provider selected for this chat cannot deliver a reason with a deny.",
      });
      return;
    }
    const resolved = await manager.resolveApproval(sessionId, approvalMatch[1]!, body.decision, reason || undefined, actor.userId);
    if (!resolved) {
      sendJson(response, 409, {
        code: "approval_not_pending",
        message: "The approval is unknown or already resolved.",
      });
      return;
    }
    sendJson(response, 200, { resolved: true });
    return;
  }

  const questionMatch = rest.match(/^\/questions\/([a-zA-Z0-9-]+)$/);
  if (questionMatch && method === "POST") {
    const body = await readJson(request);
    if (!isStringRecord(body.answers) || Object.keys(body.answers).length === 0) {
      sendJson(response, 400, {
        code: "answers_required",
        message: "answers must be a non-empty object keyed by question text.",
      });
      return;
    }
    const resolved = await manager.resolveQuestion(sessionId, questionMatch[1]!, body.answers);
    if (!resolved) {
      // Same contract as a second approval decision: the first answer wins and the second is told
      // so, rather than silently overwriting what already steered the run.
      sendJson(response, 409, {
        code: "question_not_pending",
        message: "The question is unknown or already answered.",
      });
      return;
    }
    sendJson(response, 200, { resolved: true });
    return;
  }

  if (rest === "/cancel" && method === "POST") {
    await manager.cancelSession(sessionId);
    sendJson(response, 200, { cancelled: true });
    return;
  }

  const attachmentMatch = rest.match(/^\/attachments(?:\/([^/]+))?$/);
  if (attachmentMatch) {
    await handleAttachments(request, response, manager, sessionId, method, attachmentMatch[1]);
    return;
  }

  sendJson(response, 404, { code: "not_found", message: "Unknown route." });
}

async function streamEvents(
  request: IncomingMessage,
  response: ServerResponse,
  manager: SessionManager,
  sessionId: string,
  url: URL,
  tokenExpSeconds: number,
): Promise<void> {
  const afterSeq = Number.parseInt(url.searchParams.get("after") ?? "0", 10) || 0;
  let closed = false;
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let tokenDeadline: ReturnType<typeof setTimeout> | undefined;
  const releaseSubscription = (): void => {
    const release = unsubscribe; unsubscribe = undefined; release?.();
  };
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat); clearTimeout(tokenDeadline);
    response.off("close", cleanup); request.off("aborted", cleanup);
    releaseSubscription();
  };
  // Observe cancellation before any asynchronous session lookup or replay read. IncomingMessage's
  // close event can mean a completed GET body; the response owns the long-lived stream instead.
  response.once("close", cleanup);
  request.once("aborted", cleanup);
  if (response.destroyed || response.writableEnded || request.aborted) { cleanup(); return; }

  // Checked before the headers go out: once a 200 is committed, a session that turns out to be gone
  // can only be reported as an empty stream, and the client's reconnect loop reads that as a
  // transient drop and comes straight back. A 404 is terminal on the client and says why.
  let exists: boolean;
  try { exists = !!await manager.getSession(sessionId); }
  catch (error) { cleanup(); throw error; }
  if (closed) return;
  if (!exists) {
    sendJson(response, 404, { code: "session_not_found", message: "Session not found." });
    cleanup(); return;
  }
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  const write = (event: unknown): void => {
    if (closed || response.destroyed || response.writableEnded) return;
    response.write(`data: ${JSON.stringify(event)}\n\n`);
    // The session this stream belongs to has been deleted; there is nothing further to send, and
    // holding the connection open would leave the client reconnecting into a 404.
    if ((event as { type?: string }).type === "session_deleted") {
      response.end(); cleanup();
    }
  };

  let subscription;
  try {
    subscription = await manager.subscribe(sessionId, afterSeq, write);
  } catch {
    // Deleted between the check above and this line. The headers are already out, so the only
    // honest answer is to close; the client's next attempt gets the 404.
    if (!closed) response.end();
    cleanup(); return;
  }
  unsubscribe = subscription.unsubscribe;
  // A browser can leave while subscribe reads persisted replay. Its close event has already run,
  // so dispose the late subscription explicitly and never install timers for the dead response.
  if (closed) { releaseSubscription(); return; }
  if (response.destroyed || response.writableEnded) { cleanup(); return; }
  for (const event of subscription.replay) {
    write(event);
  }
  if (closed) return;

  // Comment heartbeat keeps intermediaries from timing the idle stream out.
  heartbeat = setInterval(() => response.write(":hb\n\n"), 25_000);
  // The token was checked when the stream opened; a long-lived connection must not outlive it —
  // a revoked or downgraded admin would otherwise keep receiving transcripts indefinitely. The
  // stream ends at token expiry and the client reconnects with a freshly issued token, which
  // re-runs the full access policy on the Core side.
  tokenDeadline = setTimeout(() => {
    response.end(); cleanup();
  }, Math.max(0, tokenExpSeconds * 1000 - Date.now()));
}

function applyCors(request: IncomingMessage, response: ServerResponse): void {
  const origin = request.headers.origin;
  if (typeof origin === "string" && origin) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("vary", "origin");
    // PATCH and PUT are listed because routes use them (rename, settings). A preflight for a method
    // the server answers but does not advertise fails in the browser and nowhere else, which reads
    // as the request never having been made.
    response.setHeader("access-control-allow-methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
    response.setHeader("access-control-allow-headers", "authorization, content-type");
    response.setHeader("access-control-max-age", "600");
  }
}

/**
 * Attachments: `PUT /attachments/{name}` with the file as the raw body, `GET /attachments` to list,
 * `GET /attachments/{name}` to download.
 *
 * Raw body rather than multipart, which the plan first said. No multipart parser is among the
 * dependencies, and a hand-rolled one is the kind of code that hides its bugs; a browser sends a
 * `File` as a fetch body in one line, with the name in the path. The refusals are the caps, each
 * named, and each checked against the declared length before a byte is read — the body is bounded
 * again while it streams, since a declared length is a claim.
 */
async function handleAttachments(
  request: IncomingMessage,
  response: ServerResponse,
  manager: SessionManager,
  sessionId: string,
  method: string | undefined,
  rawName: string | undefined,
): Promise<void> {
  if (!(await manager.getSession(sessionId))) {
    sendJson(response, 404, { code: "session_not_found", message: "Session not found." });
    return;
  }
  const workspace = await manager.workspaceFor(sessionId);
  if (workspace === null) {
    // A gateway outside Core has no cache directory and therefore no workspace to put a file in.
    sendJson(response, 503, { code: "attachments_unavailable", message: "This gateway has no workspace directory." });
    return;
  }

  if (rawName === undefined && method === "GET") {
    sendJson(response, 200, { attachments: await listAttachments(workspace) });
    return;
  }

  // Decoded once, up front: `decodeURIComponent` throws on a malformed escape, and an uncaught
  // throw here is a 500 for a name the client got wrong.
  const name = rawName === undefined ? undefined : decodeNameOrNull(rawName);
  if (rawName !== undefined && name === null) {
    sendJson(response, 400, { code: "attachment_name_invalid", message: "The attachment name is not valid URL encoding." });
    return;
  }

  if (name !== undefined && method === "PUT") {
    const declared = Number.parseInt(request.headers["content-length"] ?? "", 10);
    if (!Number.isFinite(declared) || declared < 0) {
      sendJson(response, 411, { code: "length_required", message: "Content-Length is required." });
      return;
    }
    try {
      const stored = await storeAttachment(workspace, name!, declared, request);
      await manager.addAttachment(sessionId, { ...stored, path: path.join(workspace, stored.name) });
      sendJson(response, 201, { attachment: stored });
    } catch (error) {
      if (error instanceof AttachmentRefusedError) {
        const status = error.refusal.code === "attachment_name_invalid" ? 400 : 413;
        sendJson(response, status, { ...error.refusal, message: refusalMessage(error.refusal) });
        return;
      }
      throw error;
    }
    return;
  }

  if (name !== undefined && method === "GET") {
    let file: string | null;
    try {
      file = manager.attachmentPath(sessionId, name!);
    } catch {
      sendJson(response, 400, { code: "attachment_name_invalid", message: "Not a stored attachment name." });
      return;
    }
    let size: number;
    try {
      size = (await stat(file!)).size;
    } catch {
      sendJson(response, 404, { code: "attachment_not_found", message: "No such attachment." });
      return;
    }
    // Fixed type and forced download, whatever the name says: an uploaded `report.html` must not
    // render in the operator's browser, and sniffing is exactly how it would.
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": size,
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file!))}`,
      "x-content-type-options": "nosniff",
    });
    await pipeline(createReadStream(file!), response);
    return;
  }

  sendJson(response, 405, { code: "method_not_allowed", message: "Unsupported method for attachments." });
}

function decodeNameOrNull(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function refusalMessage(refusal: AttachmentRefusal): string {
  switch (refusal.code) {
    case "attachment_too_large":
      return `A single attachment may be at most ${refusal.limit} bytes.`;
    case "too_many_attachments":
      return `A session may hold at most ${refusal.limit} attachments.`;
    case "session_attachments_too_large":
      return `A session's attachments may total at most ${refusal.limit} bytes.`;
    case "attachment_name_invalid":
      return "The file name has nothing usable in it.";
  }
}

function readBearer(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  return header?.toLowerCase().startsWith("bearer ") ? header.slice("bearer ".length).trim() : undefined;
}

async function readJson(request: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) {
      throw new PayloadTooLargeError(`Request body exceeds ${maxBytes} bytes.`);
    }
    chunks.push(chunk as Buffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    // `null`, `[]` and bare primitives are valid JSON and not bodies. Every caller reads named
    // fields off what this returns, so handing back a non-object turns a malformed request into a
    // TypeError — a 500 for something the client got wrong. An empty body says the same thing and
    // each route already rejects it on its own terms.
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function isBooleanRecord(value: unknown): value is Record<string, boolean> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "boolean")
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

function mcpPreferencesRevision(settings: import("./settings/store.js").AssistantSettings): string {
  return createHash("sha256").update(JSON.stringify([settings.mcpDefaults ?? {}, settings.mcpToolRules ?? {}])).digest("hex");
}
