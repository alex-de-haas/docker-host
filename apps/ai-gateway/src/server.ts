import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isSameOriginRequest, resolveAdminActor } from "./auth.js";
import { exchangeLaunchCode } from "./app-session.js";
import { serveStaticSite } from "./settings/static-site.js";

// Upper bound for an event stream opened with an app session rather than a delegated token: the
// cookie is re-validated per request, but a stream is one request, so it gets an explicit ceiling.
const APP_SESSION_STREAM_SECONDS = 3600;
import { SessionNotFoundError, type SessionManager } from "./sessions/manager.js";
import type { HarnessAdapter } from "./harness/adapter.js";
import { MAX_SYSTEM_PROMPT_CHARS, type AssistantSettings, type SettingsStore } from "./settings/store.js";
import { partitionSkills, skillDigest, type AppSkill, type PendingSkill } from "./mcp/skills.js";
import type { ProviderDirectory } from "./settings/providers.js";
import type { McpProxy } from "./mcp/proxy.js";
import type { McpFacade } from "./facade/facade.js";

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
): Server {
  return createServer((request, response) => {
    void route(request, response, manager, adapter, settings, providers, proxy, facade).catch((error) => {
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
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://gateway.local");
  const method = request.method ?? "GET";
  applyCors(request, response);

  if (method === "OPTIONS") {
    response.writeHead(204).end();
    return;
  }

  // Outside /api and ahead of the operator gate, like the proxy below and for the same kind of
  // reason: an external agent client authenticates with a scoped access token of its own, which
  // Core introspects, rather than with an operator's delegated token (facade/facade.ts).
  if (facade && (await facade.handle(request, response, url.pathname))) {
    return;
  }

  // Before the operator gate, and deliberately outside /api: the per-session MCP proxy authenticates
  // with a session key held by the harness, not with an operator's delegated token, and it is bound
  // to loopback. Its own handler enforces both (mcp/proxy.ts).
  if (proxy && (await proxy.handle(request, response, url.pathname))) {
    return;
  }

  if (method === "GET" && url.pathname === "/healthz") {
    const availability = await adapter.probe();
    sendJson(response, 200, {
      status: "ok",
      harness: { name: adapter.name, capabilities: adapter.capabilities, ...availability },
    });
    return;
  }

  // The settings page itself is a static shell — it holds no data and fetches everything through
  // the admin-gated /api routes below with a delegated token, exactly as the chat panel does. Serving
  // the shell without a token is what lets Shell embed it as an ordinary app UI.
  // The launch code Shell puts on the URL becomes this app's session cookie. Unauthenticated by
  // necessity — establishing the session is what it does — and safe because the code itself is the
  // credential: Core minted it for one user and one app, and refuses a stale or foreign one.
  if (method === "POST" && url.pathname === "/api/app-code") {
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

    const forwardedProto = request.headers["x-forwarded-proto"];
    const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
    const exchange = await exchangeLaunchCode(code, (proto ?? "").split(",")[0]?.trim() === "https");
    if (!exchange.ok) {
      sendJson(response, exchange.status, { code: exchange.code, message: exchange.message });
      return;
    }

    response.writeHead(204, { "set-cookie": exchange.setCookie });
    response.end();
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

  // Everything under /api is operator surface: admin-only by decision, no anonymous reads. Two
  // credential shapes, because there are two clients — the Shell assistant panel presents a
  // delegated token, the settings page its own Hosty session. Both must resolve to an administrator.
  const actor = await resolveAdminActor(request);
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

  if (method === "GET" && url.pathname === "/api/health") {
    const availability = await adapter.probe();
    // Capabilities travel with health because the client needs them to decide what to render: a
    // harness that cannot ask questions must not get a question card, and one that cannot be
    // reconfigured live must not be described as applying a toggle immediately.
    sendJson(response, 200, {
      status: "ok",
      harness: { name: adapter.name, capabilities: adapter.capabilities, ...availability },
    });
    return;
  }

  // Approving one app's changed skill.
  //
  // Takes the digest the operator was shown, not just the app id: between the page rendering the text
  // and the click, another update could land, and "approve whatever is current" would then approve
  // words nobody read — which is the failure this whole mechanism exists to prevent, arriving through
  // its own approval path.
  if (url.pathname === "/api/settings/skills/approve" && settings && method === "POST") {
    const body = await readJson(request);
    const appId = typeof body.appId === "string" ? body.appId.trim() : "";
    const digest = typeof body.digest === "string" ? body.digest.trim() : "";
    if (!appId || !digest) {
      sendJson(response, 422, {
        code: "skill_approval_invalid",
        message: "appId and digest are required.",
      });
      return;
    }

    const skill = providers ? await providers.readSkill(appId) : null;
    if (!skill) {
      sendJson(response, 404, { code: "skill_not_found", message: "That app declares no agent skill." });
      return;
    }

    if (skillDigest(skill.markdown) !== digest) {
      sendJson(response, 409, {
        code: "skill_changed_again",
        message: "This app's skill changed again since it was shown. Review the new text.",
      });
      return;
    }

    await settings.mergeSkillDigests({ [appId]: digest });
    sendJson(response, 200, { appId, digest });
    return;
  }

  if (url.pathname === "/api/settings" && settings && (method === "GET" || method === "PUT")) {
    if (method === "PUT") {
      const body = await readJson(request);
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
      if (body.mcpProviders !== undefined && !isBooleanRecord(body.mcpProviders)) {
        sendJson(response, 400, {
          code: "mcp_providers_invalid",
          message: "mcpProviders must be an object of appId -> boolean.",
        });
        return;
      }
      if (body.mcpAutoAllow !== undefined && !isBooleanRecord(body.mcpAutoAllow)) {
        sendJson(response, 400, {
          code: "mcp_auto_allow_invalid",
          message: "mcpAutoAllow must be an object of appId -> boolean.",
        });
        return;
      }
      // Enabling a provider is where consent happens, so it is where the skill's baseline is taken:
      // the text the app ships *at that moment* is what the operator is accepting. Recording it later,
      // at first delivery, let an update land in between and approve itself.
      const skillBaseline = isBooleanRecord(body.mcpProviders)
        ? await snapshotEnabledSkills(providers, settings, body.mcpProviders)
        : {};

      await settings.update({
        systemPrompt: typeof body.systemPrompt === "string" ? body.systemPrompt : undefined,
        mcpProviders: isBooleanRecord(body.mcpProviders) ? body.mcpProviders : undefined,
        mcpAutoAllow: isBooleanRecord(body.mcpAutoAllow) ? body.mcpAutoAllow : undefined,
      });
      if (Object.keys(skillBaseline).length > 0) {
        await settings.mergeSkillDigests(skillBaseline);
      }
      if (isBooleanRecord(body.mcpProviders) || isBooleanRecord(body.mcpAutoAllow)) {
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

    const current = await settings.read();
    // Withheld skills travel with the settings, because withholding silently would be the worst of
    // both designs: the operator's decision is honoured and they never learn there is one to make.
    // The new text comes too — approving prose you cannot read is not approval.
    const pendingSkills = await readPendingSkills(providers, discovered?.providers ?? [], current);
    // Capabilities ride along so the page can say what a change actually does on this harness
    // instead of one wording that is false on one of them.
    sendJson(response, 200, {
      settings: current,
      pendingSkills,
      providers: discovered?.providers ?? [],
      discovery: discovered ? "ok" : "unavailable",
      harness: { name: adapter.name, capabilities: adapter.capabilities },
      limits: { systemPromptChars: MAX_SYSTEM_PROMPT_CHARS },
    });
    return;
  }

  if (url.pathname === "/api/sessions" && method === "POST") {
    const body = await readJson(request);
    const record = await manager.createSession({
      title: typeof body.title === "string" ? body.title : undefined,
      context: isStringRecord(body.context) ? body.context : undefined,
      createdBy: actor.userId,
    });
    sendJson(response, 200, record);
    return;
  }

  if (url.pathname === "/api/sessions" && method === "GET") {
    sendJson(response, 200, { sessions: await manager.listSessions() });
    return;
  }

  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([a-zA-Z0-9-]+)(\/.*)?$/);
  if (!sessionMatch) {
    sendJson(response, 404, { code: "not_found", message: "Unknown route." });
    return;
  }

  const sessionId = sessionMatch[1]!;
  const rest = sessionMatch[2] ?? "";

  if (rest === "" && method === "GET") {
    const record = await manager.getSession(sessionId);
    if (!record) {
      sendJson(response, 404, { code: "session_not_found", message: "Session not found." });
      return;
    }
    sendJson(response, 200, record);
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
    const record = await manager.renameSession(sessionId, body.title);
    if (!record) {
      sendJson(response, 404, { code: "session_not_found", message: "Session not found." });
      return;
    }
    sendJson(response, 200, record);
    return;
  }

  if (rest === "" && method === "DELETE") {
    const deleted = await manager.deleteSession(sessionId, actor.userId);
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

  if (rest === "/messages" && method === "POST") {
    const body = await readJson(request);
    if (typeof body.text !== "string" || !body.text.trim()) {
      sendJson(response, 400, { code: "text_required", message: "A non-empty text field is required." });
      return;
    }
    // The presented token seeds the session's delegation chain; see SessionManager.postMessage.
    await manager.postMessage(sessionId, body.text, readBearer(request));
    sendJson(response, 202, { accepted: true });
    return;
  }

  const approvalMatch = rest.match(/^\/approvals\/([a-zA-Z0-9-]+)$/);
  if (approvalMatch && method === "POST") {
    const body = await readJson(request);
    if (body.decision !== "allow" && body.decision !== "deny") {
      sendJson(response, 400, { code: "decision_invalid", message: "decision must be 'allow' or 'deny'." });
      return;
    }
    const resolved = await manager.resolveApproval(
      sessionId,
      approvalMatch[1]!,
      body.decision,
      typeof body.message === "string" ? body.message : undefined,
    );
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
  // Checked before the headers go out: once a 200 is committed, a session that turns out to be gone
  // can only be reported as an empty stream, and the client's reconnect loop reads that as a
  // transient drop and comes straight back. A 404 is terminal on the client and says why.
  if (!(await manager.getSession(sessionId))) {
    sendJson(response, 404, { code: "session_not_found", message: "Session not found." });
    return;
  }
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  const write = (event: unknown): void => {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
    // The session this stream belongs to has been deleted; there is nothing further to send, and
    // holding the connection open would leave the client reconnecting into a 404.
    if ((event as { type?: string }).type === "session_deleted") {
      response.end();
    }
  };

  let subscription;
  try {
    subscription = await manager.subscribe(sessionId, afterSeq, write);
  } catch {
    // Deleted between the check above and this line. The headers are already out, so the only
    // honest answer is to close; the client's next attempt gets the 404.
    response.end();
    return;
  }
  const { replay, unsubscribe } = subscription;
  for (const event of replay) {
    write(event);
  }

  // Comment heartbeat keeps intermediaries from timing the idle stream out.
  const heartbeat = setInterval(() => response.write(":hb\n\n"), 25_000);
  // The token was checked when the stream opened; a long-lived connection must not outlive it —
  // a revoked or downgraded admin would otherwise keep receiving transcripts indefinitely. The
  // stream ends at token expiry and the client reconnects with a freshly issued token, which
  // re-runs the full access policy on the Core side.
  const tokenDeadline = setTimeout(
    () => response.end(),
    Math.max(0, tokenExpSeconds * 1000 - Date.now()),
  );
  // Bound to the response as well as the request: this stream can be ended from the server side
  // (a deletion, the token deadline), and waiting only on the request's own close would leave the
  // heartbeat writing into a finished response — which throws rather than being ignored.
  // Idempotent, so being called from both is harmless.
  const cleanup = (): void => {
    clearInterval(heartbeat);
    clearTimeout(tokenDeadline);
    unsubscribe();
  };
  response.on("close", cleanup);
  request.on("close", cleanup);
}

/**
 * The approved-digest map after a provider toggle, with a baseline taken for whatever was just
 * switched on.
 *
 * Only for apps moving from off to on. Re-recording on every save would silently re-approve an app
 * whose text changed while it was already enabled — the operator would keep pressing Save on an
 * unrelated setting and keep accepting text they never saw.
 *
 * An app whose skill cannot be read right now gets no baseline, so its skill is withheld until
 * approved. That is the fail-closed half of the same rule: no snapshot, no delivery.
 */
async function snapshotEnabledSkills(
  providers: ProviderDirectory | null,
  settings: SettingsStore,
  nextProviders: Record<string, boolean>,
): Promise<Record<string, string>> {
  if (!providers) {
    return {};
  }

  const current = await settings.read();
  const newlyEnabled = Object.entries(nextProviders)
    .filter(([appId, enabled]) => enabled && current.mcpProviders[appId] !== true)
    .map(([appId]) => appId);
  if (newlyEnabled.length === 0) {
    return {};
  }

  const digests: Record<string, string> = {};
  for (const appId of newlyEnabled) {
    const skill = await providers.readSkill(appId);
    if (skill) {
      digests[appId] = skillDigest(skill.markdown);
    }
  }

  return digests;
}

/**
 * The skills of enabled providers whose text has changed since the operator accepted it.
 *
 * Read on the settings page rather than pushed from a session: a withheld skill has to be visible
 * where the decision is made, and a session that quietly dropped one leaves no trace anywhere else.
 */
async function readPendingSkills(
  providers: ProviderDirectory | null,
  discovered: readonly { appId: string }[],
  current: AssistantSettings,
): Promise<PendingSkill[]> {
  if (!providers) {
    return [];
  }

  const enabled = discovered.filter((provider) => current.mcpProviders[provider.appId] === true);
  const skills = await Promise.all(enabled.map((provider) => providers.readSkill(provider.appId)));
  return partitionSkills(
    skills.filter((skill): skill is AppSkill => skill !== null),
    current.mcpSkillDigests,
  ).pending;
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

function readBearer(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  return header?.toLowerCase().startsWith("bearer ") ? header.slice("bearer ".length).trim() : undefined;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      throw new PayloadTooLargeError(`Request body exceeds ${MAX_BODY_BYTES} bytes.`);
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
