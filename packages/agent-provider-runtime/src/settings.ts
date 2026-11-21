import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isValidCodeVerifier, resolveAppAuthProtocol } from "@hosty-sdk/app/app-code";
import { readAppContinuity, type AppContinuity } from "@hosty-sdk/app/continuity";
import { AgentConnections, ConnectionError } from "./internal/connections/registry.js";

export type UsagePresentationPolicy = {
  grouping?: "model" | "account"; accountGroups?: string[]; knownGroups?: string[]; scopedGroupPrefixes?: string[]; resetLabels?: boolean;
};
export type ProviderSettingsDefinition = {
  kind: string; name: string; connectionName?: string;
  authentication: Array<{ id: string; label: string; credential?: boolean; hostDirectory?: boolean; browserLogin?: boolean; interfaceChoices?: Array<{ kind: string; label: string; statusLabel?: string }> }>;
  hostDirectory?: { label: string; placeholder: string; description: string };
  baseUrl?: { label: string; placeholder: string; description: string };
  login?: { name: string; description: string };
  usage?: UsagePresentationPolicy;
};
export type ProviderSettingsOptions = {
  definition: ProviderSettingsDefinition; connections: Pick<AgentConnections, "list" | "get" | "update" | "remove" | "setDefault" | "startLogin" | "fetchLogin" | "cancelLogin" | "usage">;
  isConnectionInUse: (id: string) => Promise<boolean>; env?: NodeJS.ProcessEnv; fetch?: typeof fetch;
};
type Actor = { userId: string; hostRole: string; activeUntil?: string | null; activityRequired?: boolean; continuity?: AppContinuity };
type Session = { status: "active"; identity: Actor } | { status: "not-present" | "expired" | "forbidden" | "unavailable" | "misconfigured" };
class SettingsError extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message); } }
const json = (response: ServerResponse, status: number, value: unknown) => { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" }); response.end(JSON.stringify(value)); };
const sameOrigin = (request: IncomingMessage) => {
  if (request.headers["sec-fetch-site"] === "same-origin") return true;
  try { return typeof request.headers.origin === "string" && new URL(request.headers.origin).host === request.headers.host; } catch { return false; }
};
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json") throw new SettingsError(415, "json_required", "Send application/json.");
  const parts: Buffer[] = []; let bytes = 0;
  for await (const value of request) { const chunk = Buffer.from(value); bytes += chunk.byteLength; if (bytes > 65536) throw new SettingsError(413, "body_budget", "The settings request is too large."); parts.push(chunk); }
  let value: unknown; try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts))); } catch { throw new SettingsError(400, "invalid_json", "Send valid UTF-8 JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SettingsError(400, "invalid_input", "Send a settings object."); return value as Record<string, unknown>;
}

/** App-owned settings and Core login. Native execution credentials are never browser identity. */
export function createProviderSettings(options: ProviderSettingsOptions): (request: IncomingMessage, response: ServerResponse, pathname: string) => Promise<boolean> {
  const definition = options.definition;
  if (!definition.kind || !definition.name || !definition.authentication.length) throw new Error("Select a provider settings definition.");
  const env = options.env ?? process.env, fetcher = options.fetch ?? globalThis.fetch;
  const appId = env.HOSTY_APP_ID ?? "", core = env.HOSTY_CORE_ORIGIN ?? "", service = env.HOSTY_APP_SERVICE_TOKEN ?? "";
  const cookie = "hosty_provider_" + createHash("sha256").update(appId).digest("hex").slice(0, 12);
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(action: () => Promise<T>): Promise<T> => { const next = queue.catch(() => {}).then(action); queue = next; return next; };
  const readCredential = (request: IncomingMessage): string | null => {
    if (request.headers.authorization?.startsWith("Bearer hostyg_")) return request.headers.authorization.slice(7).trim();
    const part = request.headers.cookie?.split(";").map(p => p.trim()).find(p => p.startsWith(cookie + "="));
    try { return part ? decodeURIComponent(part.slice(cookie.length + 1)) : null; } catch { return null; }
  };
  const coreRequest = async (route: string, input: unknown): Promise<Response> => {
    if (!appId || !core || !service) throw new SettingsError(503, "core_required", "Start this provider through Hosty Core.");
    try { return await fetcher(new URL(route, core), { method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(5000), headers: { authorization: `Bearer ${service}`, "content-type": "application/json" }, body: JSON.stringify(input) }); }
    catch { throw new SettingsError(503, "core_unavailable", "Hosty Core is temporarily unavailable. Retry without signing out."); }
  };
  const session = async (token: string | null): Promise<Session> => {
    if (!token) return { status: "not-present" };
    if (!appId || !core || !service) return { status: "misconfigured" };
    let response: Response; try { response = await coreRequest("/api/auth/apps/revalidate", { accessToken: token }); } catch { return { status: "unavailable" }; }
    if (!response.ok) return { status: response.status === 401 ? "expired" : response.status === 403 ? "forbidden" : "unavailable" };
    const value = await response.json().catch(() => null) as { active?: unknown; appId?: unknown; userId?: unknown; hostRole?: unknown; activeUntil?: unknown; activityRequired?: unknown; continuity?: unknown } | null;
    if (value?.active !== true || value.appId !== appId || typeof value.userId !== "string" || !value.userId) return { status: "unavailable" };
    if (value.hostRole !== "host.admin") return { status: "forbidden" };
    return { status: "active", identity: { userId: value.userId, hostRole: value.hostRole, activeUntil: typeof value.activeUntil === "string" ? value.activeUntil : null, activityRequired: value.activityRequired === true, continuity: readAppContinuity(value.continuity) } };
  };
  const recovery = async () => ({ appId, corePublicOrigin: env.HOSTY_CORE_PUBLIC_ORIGIN ?? null, appAuthProtocol: await resolveAppAuthProtocol(core || null) });
  const current = async (id: string, input?: Record<string, unknown>) => {
    const connection = await options.connections.get(id);
    if (connection.kind !== definition.kind) throw new SettingsError(404, "connection_missing", "Connection not found.");
    if (input && input.expectedRevision !== String(connection.revision)) throw new SettingsError(409, "connection_changed", "The connection changed. Refresh before trying again.");
    return connection;
  };
  const inactive = async (id: string) => { if (await options.isConnectionInUse(id)) throw new SettingsError(409, "connection_in_use", "Stop and reconcile this connection's active execution before changing it."); };
  const inventory = async () => {
    const result = await options.connections.list();
    return { kind: definition.kind, defaultId: result.defaultId, defaults: result.defaults, connections: result.connections.filter(c => c.kind === definition.kind).map(c => ({ id: c.id, name: c.name, kind: c.kind, auth: c.auth, revision: String(c.revision), baseUrl: c.baseUrl, hostDirectory: c.hostDirectory, ...(definition.authentication.find(method => method.id === c.auth)?.interfaceChoices ? { publishedInterfaces: c.publishedInterfaces ?? [], settingsRevision: String(c.settingsRevision ?? c.revision) } : {}), available: c.available, reason: c.reason })) };
  };
  return async (request, response, pathname) => {
    const method = request.method ?? "GET";
    if (method === "GET" && (pathname === "/" || pathname === "/settings")) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" }); response.end(settingsHtml(definition)); return true;
    }
    const assetType = (pathname === "/settings-browser.mjs" || pathname === "/settings-bootstrap.js") ? "text/javascript; charset=utf-8"
      : pathname === "/settings.css" || pathname === "/hosty-theme.css" ? "text/css; charset=utf-8"
      : /^\/fonts\/(?:plex-sans|jetbrains-mono)-(?:latin|latin-ext|cyrillic)\.woff2$/.test(pathname) ? "font/woff2" : null;
    if (method === "GET" && assetType) {
      try { const content = await readFile(new URL("." + pathname, import.meta.url)); response.writeHead(200, { "content-type": assetType, "cache-control": "no-store", "x-content-type-options": "nosniff" }); response.end(content); }
      catch { json(response, 503, { code: "build_required", message: "Build this provider before opening settings." }); } return true;
    }
    if (!pathname.startsWith("/api/settings/") && !pathname.startsWith("/api/auth/")) return false;
    try {
      if ((pathname === "/api/auth/session" || pathname === "/api/auth/identity") && method === "GET") {
        const resolved = await session(readCredential(request)); json(response, 200, { status: resolved.status, ...(resolved.status === "active" ? resolved.identity : {}), recovery: await recovery() }); return true;
      }
      if (method !== "GET" && !sameOrigin(request) && !request.headers.authorization?.startsWith("Bearer hostyg_")) throw new SettingsError(403, "same_origin_required", "Use this application's own settings page.");
      if (pathname === "/api/auth/exchange" && method === "POST") {
        const input = await body(request);
        if (typeof input.code !== "string" || !input.code || input.code.length > 8192 || !isValidCodeVerifier(input.codeVerifier) || Object.keys(input).some(k => !["code", "codeVerifier"].includes(k))) throw new SettingsError(400, "proof_required", "A valid app-owned Hosty sign-in proof is required.");
        if (await resolveAppAuthProtocol(core || null) !== 2) throw new SettingsError(503, "protocol_unavailable", "Hosty sign-in protocol could not be verified.");
        const exchanged = await coreRequest("/api/auth/apps/token", input);
        if (!exchanged.ok) throw new SettingsError(exchanged.status === 401 ? 401 : exchanged.status === 403 ? 403 : 503, "sign_in_failed", "Hosty sign-in could not be completed.");
        const result = await exchanged.json().catch(() => null) as { accessToken?: unknown; expiresInSeconds?: unknown } | null;
        if (typeof result?.accessToken !== "string" || !Number.isSafeInteger(result.expiresInSeconds) || Number(result.expiresInSeconds) <= 0) throw new SettingsError(503, "identity_unavailable", "Core returned no usable app identity.");
        const checked = await session(result.accessToken); if (checked.status !== "active") throw new SettingsError(checked.status === "forbidden" ? 403 : 503, "identity_unavailable", "An administrator with access to this provider is required.");
        const secure = request.headers["x-forwarded-proto"]?.toString().split(",")[0]?.trim() === "https" || "encrypted" in request.socket;
        response.setHeader("set-cookie", `${cookie}=${encodeURIComponent(result.accessToken)}; HttpOnly; Path=/; Max-Age=${result.expiresInSeconds}; SameSite=${secure ? "None; Secure" : "Lax"}`);
        json(response, 200, { accessToken: result.accessToken, expiresInSeconds: result.expiresInSeconds, ...checked.identity }); return true;
      }
      const resolved = await session(readCredential(request));
      if (resolved.status !== "active") { if (resolved.status === "expired") response.setHeader("set-cookie", `${cookie}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`); throw new SettingsError(["unavailable", "misconfigured"].includes(resolved.status) ? 503 : resolved.status === "forbidden" ? 403 : 401, "app_identity_required", "Sign in to this provider through Hosty Core as an administrator."); }
      if (pathname === "/api/settings/connections" && method === "GET") { json(response, 200, await inventory()); return true; }
      const usageRoute = /^\/api\/settings\/connections\/([A-Za-z0-9-]{1,80})\/usage$/.exec(pathname);
      if (usageRoute && method === "GET") {
        const query = new URL(request.url ?? pathname, "http://provider.invalid").searchParams;
        if ([...query.keys()].some(key => key !== "refresh") || query.getAll("refresh").length > 1 || query.has("refresh") && !["true", "false"].includes(query.get("refresh")!)) throw new SettingsError(400, "invalid_input", "Use refresh=true or refresh=false.");
        const connection = await current(usageRoute[1]!);
        const usage = await options.connections.usage(connection.id, query.get("refresh") === "true");
        const after = await current(connection.id);
        if (after.revision !== connection.revision || usage.connectionRevision !== undefined && usage.connectionRevision !== after.revision) throw new SettingsError(409, "connection_changed", "The connection changed. Refresh before reading its usage.");
        json(response, 200, { ...usage, connectionRevision: String(after.revision) }); return true;
      }
      const connectionRoute = /^\/api\/settings\/connections(?:\/([A-Za-z0-9-]{1,80}))?(?:\/(login))?$/.exec(pathname);
      const loginRoute = /^\/api\/settings\/logins\/([A-Za-z0-9-]{1,80})$/.exec(pathname);
      if (connectionRoute && ["POST", "PUT", "DELETE"].includes(method)) {
        const id = connectionRoute[1], input = await body(request);
        await serial(async () => {
          const existing = id ? await current(id, input) : null;
          if (id && existing) {
            // Publishing an interface changes eligibility for new calls without modifying the active agent.
            const interfacesOnly = method === "PUT" && !connectionRoute[2] && Array.isArray(input.publishedInterfaces)
              && definition.authentication.some(auth => auth.id === existing.auth && auth.interfaceChoices?.length)
              && (input.name === undefined || input.name === existing.name) && (input.auth === undefined || input.auth === existing.auth)
              && Object.keys(input).every(field => ["expectedRevision", "expectedSettingsRevision", "name", "auth", "publishedInterfaces"].includes(field));
            if (!interfacesOnly) await inactive(id);
          }
          if (id && connectionRoute[2] === "login" && method === "POST") { if (Object.keys(input).some(k => k !== "expectedRevision")) throw new SettingsError(400, "invalid_input", "Unexpected login fields."); json(response, 200, await options.connections.startLogin(id)); }
          else if (id && !connectionRoute[2] && method === "DELETE") { await options.connections.remove(id); json(response, 200, { removed: true }); }
          else if ((!id && method === "POST" || id && method === "PUT") && !connectionRoute[2]) {
            const auth = input.auth ?? existing?.auth;
            const choices = definition.authentication.find(method => method.id === auth)?.interfaceChoices;
            if (Object.keys(input).some(k => !["name", "auth", "secret", "baseUrl", "hostDirectory", "expectedRevision", ...(choices ? ["expectedSettingsRevision", "publishedInterfaces"] : [])].includes(k))) throw new SettingsError(400, "invalid_input", "Unexpected connection fields.");
            const { expectedRevision: _revision, ...update } = input;
            const saved = await options.connections.update({ ...update, kind: definition.kind }, id);
            json(response, 200, { ...await inventory(), saved: { id: saved.id, revision: String(saved.revision) } });
          } else throw new SettingsError(405, "method_not_allowed", "Unsupported settings operation.");
        }); return true;
      }
      if (loginRoute && method === "GET") { const login = await options.connections.fetchLogin(loginRoute[1]!); await current(login.connectionId); json(response, 200, login); return true; }
      if (loginRoute && method === "DELETE") { await serial(async () => { const login = await options.connections.fetchLogin(loginRoute[1]!); await current(login.connectionId); await inactive(login.connectionId); await options.connections.cancelLogin(loginRoute[1]!); }); json(response, 200, { cancelled: true }); return true; }
      if (pathname === "/api/settings/default" && method === "PUT") { const input = await body(request); if (typeof input.id !== "string" || Object.keys(input).some(k => k !== "id")) throw new SettingsError(400, "invalid_input", "Select a connection ID."); await current(input.id); await options.connections.setDefault(input.id); json(response, 200, await inventory()); return true; }
      throw new SettingsError(404, "not_found", "Settings endpoint not found.");
    } catch (error) {
      const known = error instanceof SettingsError || error instanceof ConnectionError;
      json(response, known ? error.status : 503, { code: known ? error.code : "settings_unavailable", message: known ? error.message : "Provider settings are temporarily unavailable. Existing account data is preserved." });
    }
    return true;
  };
}
const htmlText = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
export function settingsHtml(definition: ProviderSettingsDefinition): string {
  const kind = htmlText(definition.kind), name = htmlText(definition.name), host = definition.hostDirectory, url = definition.baseUrl;
  const login = definition.login ?? { name: "provider", description: "Complete this account's browser sign-in." };
  const descriptor = JSON.stringify(definition).replaceAll("<", "\\u003c");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name} provider settings</title><script src="/settings-bootstrap.js"></script><link rel="stylesheet" href="/hosty-theme.css"><link rel="stylesheet" href="/settings.css"></head>
<body data-provider-kind="${kind}"><script id="provider-definition" type="application/json">${descriptor}</script><main class="settings-page"><header class="app-heading"><h1>${name} provider</h1></header>
<div class="access-status"><p id="message" role="status">Checking Hosty access…</p><div class="access-actions"><button id="signin" class="button button-outline" type="button">Sign in through Hosty</button><button id="refresh" class="button button-outline button-sm" type="button">Refresh</button></div></div>
<div id="protected" hidden><section class="providers" aria-labelledby="providers-heading"><div class="section-heading"><div><h2 id="providers-heading">Providers</h2></div><button id="add-provider" class="button button-outline button-sm" type="button">+ Add provider</button></div><div id="connections" class="connections" aria-live="polite" aria-busy="true"></div></section></div></main>
<dialog id="editor" aria-labelledby="form-title" aria-describedby="form-description" class="dialog"><form id="connection-form" class="dialog-form"><div class="dialog-header"><h2 id="form-title">Add provider</h2><p id="form-description">Configure this provider’s connection.</p></div><button id="editor-close" class="dialog-close button button-ghost button-icon" aria-label="Close" type="button"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m18 6-12 12M6 6l12 12"/></svg></button><div class="dialog-body"><fieldset id="connection-fields" class="form-fields">
<div class="field"><label for="name">Connection name</label><input id="name" maxlength="100" placeholder="My ${name}" required></div>
<div class="field"><label for="auth">Authentication</label><select id="auth"></select></div>
<p id="browser-login-description" class="field-description" hidden>${htmlText(login.description)}</p>
<div id="secret-field" class="field"><label for="secret">Credential</label><input id="secret" type="password" autocomplete="new-password" aria-describedby="secret-description"><p id="secret-description" class="field-description">Credentials are stored securely for this provider. Leave blank when editing to keep the current credential.</p></div>
<div id="host-field" class="field"><label for="hostDirectory">${htmlText(host?.label ?? "Existing account directory")}</label><input id="hostDirectory" placeholder="${htmlText(host?.placeholder ?? "")}" aria-describedby="host-description"><p id="host-description" class="field-description">${htmlText(host?.description ?? "")}</p></div>
<div id="url-field" class="field"><label for="baseUrl">${htmlText(url?.label ?? "Server URL")}</label><input id="baseUrl" type="url" maxlength="2048" placeholder="${htmlText(url?.placeholder ?? "")}" aria-describedby="url-description"><p id="url-description" class="field-description">${htmlText(url?.description ?? "")}</p></div>
<div id="interface-choices" class="field" hidden></div>
</fieldset><p id="form-error" class="alert alert-error" role="alert" hidden></p></div><div class="dialog-footer"><button id="save-provider" type="submit" class="button button-sm">Save provider</button><button id="clear" type="button" class="button button-outline button-sm">Cancel</button></div></form></dialog>
<dialog id="login-dialog" class="dialog login-dialog" aria-labelledby="login-title" aria-describedby="login-description"><div class="dialog-header"><h2 id="login-title">Sign in with ${htmlText(login.name)}</h2><p id="login-description">${htmlText(login.description)}</p></div><div class="dialog-body"><div id="login-code-row" class="login-code"><code id="login-code">Preparing…</code><button id="copy-code" type="button" class="button button-ghost button-icon" aria-label="Copy code">⧉</button></div><p id="login-status" class="field-description" role="status">Waiting for confirmation…</p><p id="login-error" role="alert" class="alert alert-error" hidden></p></div><div class="dialog-footer"><button id="login-close" class="button button-outline" type="button">Cancel sign-in</button><a id="login-open" class="button" target="_blank" rel="noopener noreferrer" hidden>Open ${htmlText(login.name)}</a></div></dialog><script type="module" src="/settings-browser.mjs"></script></body></html>`;
}
