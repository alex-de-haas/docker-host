import { sha256 } from "@noble/hashes/sha2.js";
import type { AppAuthProtocol } from "./app-code";

function isValidCodeVerifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._~-]{43,128}$/.test(value);
}

export type AppSignInResult = { code: string; codeVerifier: string };
export type AppAuthAttempt = {
  state: string; codeVerifier: string; codeChallenge: string; appId: string; coreOrigin: string;
  redirectUri: string; createdAt: number; mode: "standalone" | "silent" | "popup" | "native";
  protocol: AppAuthProtocol;
};
export const APP_AUTH_ATTEMPT_PREFIX = "hosty.auth.attempt:";
const MINIMUM_PROTOCOL_PREFIX = "hosty.auth.protocol:";
const ATTEMPT_LIFETIME = 300_000;
const MAX_ATTEMPTS = 16;
const protocolMinimums = new Set<string>();

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function appCodeChallenge(verifier: string): string {
  if (!isValidCodeVerifier(verifier)) throw new Error("The sign-in proof is invalid.");
  return base64url(sha256(Uint8Array.from(verifier, character => character.charCodeAt(0))));
}

export function acceptAppAuthProtocol(coreOrigin: string, protocol: AppAuthProtocol | null): AppAuthProtocol | null {
  const key = `${MINIMUM_PROTOCOL_PREFIX}${coreOrigin}`;
  try { if (window.sessionStorage.getItem(key) === "2") protocolMinimums.add(coreOrigin); } catch { /* Memory minimum still applies. */ }
  if (protocol === 2) {
    protocolMinimums.add(coreOrigin);
    try { window.sessionStorage.setItem(key, "2"); } catch { /* Keep the minimum in memory. */ }
    return 2;
  }
  return protocol === 1 && !protocolMinimums.has(coreOrigin) ? 1 : null;
}

export function createAppAuthAttempt(openUrl: string, mode: AppAuthAttempt["mode"], protocol: AppAuthProtocol): AppAuthAttempt {
  const url = new URL(openUrl);
  const match = /^\/api\/apps\/([^/]+)\/open$/.exec(url.pathname);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !match)
    throw new Error("Hosty sign-in URL is invalid.");
  if (acceptAppAuthProtocol(url.origin, protocol) !== protocol) throw new Error("Hosty sign-in protocol could not be verified.");
  const redirect = new URL(url.searchParams.get("redirectUri") ?? "");
  if (redirect.origin !== window.location.origin || redirect.username || redirect.password || redirect.hash)
    throw new Error("Hosty sign-in must return to this app.");
  const codeVerifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
  redirect.searchParams.delete("code"); redirect.searchParams.delete("error");
  redirect.searchParams.set("state", state);
  return { state, codeVerifier, codeChallenge: appCodeChallenge(codeVerifier), appId: decodeURIComponent(match[1]),
    coreOrigin: url.origin, redirectUri: redirect.href, createdAt: Date.now(), mode, protocol };
}

function storedAttempts(): string[] {
  const keys: string[] = [];
  const storage = window.sessionStorage;
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith(APP_AUTH_ATTEMPT_PREFIX)) continue;
    try {
      const record = JSON.parse(storage.getItem(key) ?? "null");
      if (typeof record?.createdAt !== "number" || record.createdAt > Date.now() || Date.now() - record.createdAt >= ATTEMPT_LIFETIME) {
        storage.removeItem(key); index--; continue;
      }
    } catch { storage.removeItem(key); index--; continue; }
    keys.push(key);
  }
  return keys;
}

/** Do not leave the app document unless this exact proof survives a storage round trip. */
export function persistAppAuthAttempt(attempt: AppAuthAttempt): boolean {
  const key = `${APP_AUTH_ATTEMPT_PREFIX}${attempt.state}`;
  try {
    if (storedAttempts().length >= MAX_ATTEMPTS) return false;
    const value = JSON.stringify(attempt);
    window.sessionStorage.setItem(key, value);
    if (window.sessionStorage.getItem(key) === value) return true;
  } catch { /* The explicit popup can keep a proof in memory instead. */ }
  try { window.sessionStorage.removeItem(key); } catch { /* Storage remains blocked. */ }
  return false;
}

function callbackLocation(url: URL): string {
  const copy = new URL(url);
  for (const name of ["code", "state", "error", "hosty_launch"]) copy.searchParams.delete(name);
  copy.hash = "";
  copy.searchParams.sort();
  return copy.href;
}

/** Correlation is local; URL fields never supply a verifier or a pending attempt. */
// Only the recovery bridge opts in to classify and discard an obsolete local v1
// record. Such a record must never be exchanged after v2 has already been observed.
export function takeAppAuthAttempt(callback: URL, allowLegacyUpgrade = false): AppAuthAttempt | null {
  const states = callback.searchParams.getAll("state");
  const state = states[0];
  if (!state || !/^[a-f0-9]{64}$/.test(state) || states.some(value => value !== state)) return null;
  const key = `${APP_AUTH_ATTEMPT_PREFIX}${state}`;
  try {
    const value = window.sessionStorage.getItem(key);
    if (!value) return null;
    window.sessionStorage.removeItem(key);
    const attempt = JSON.parse(value) as AppAuthAttempt;
    if (attempt.state !== state || !isValidCodeVerifier(attempt.codeVerifier) ||
        attempt.codeChallenge !== appCodeChallenge(attempt.codeVerifier) ||
        ![1, 2].includes(attempt.protocol) || !["standalone", "silent", "native"].includes(attempt.mode) ||
        typeof attempt.appId !== "string" || !attempt.appId ||
        typeof attempt.createdAt !== "number" || attempt.createdAt > Date.now() || Date.now() - attempt.createdAt >= ATTEMPT_LIFETIME ||
        new URL(attempt.redirectUri).origin !== window.location.origin || callbackLocation(new URL(attempt.redirectUri)) !== callbackLocation(callback) ||
        new URL(attempt.coreOrigin).origin !== attempt.coreOrigin ||
        (acceptAppAuthProtocol(attempt.coreOrigin, attempt.protocol) !== attempt.protocol && !(allowLegacyUpgrade && attempt.protocol === 1))) return null;
    return attempt;
  } catch { return null; }
}

export function clearAppAuthAttempts(): void {
  if (typeof window === "undefined") return;
  try { for (const key of storedAttempts()) window.sessionStorage.removeItem(key); } catch { /* Nothing can navigate with inaccessible proof. */ }
}

export function appAuthNavigationUrl(attempt: AppAuthAttempt): string {
  const url = new URL(`/api/apps/${encodeURIComponent(attempt.appId)}/open`, attempt.coreOrigin);
  for (const [name, value] of Object.entries(appAuthFields(attempt))) url.searchParams.set(name, value);
  return url.href;
}

function appAuthFields(attempt: AppAuthAttempt): Record<string, string> {
  return { redirectUri: attempt.redirectUri, state: attempt.state, codeChallenge: attempt.codeChallenge, codeChallengeMethod: "S256",
    ...(attempt.mode === "silent" ? { prompt: "none" } : {}),
    ...(attempt.mode === "popup" ? { responseMode: "web_message" } : {}) };
}

/** Constant document and DOM-built fields prevent a public URL from laundering a challenge. */
export function submitAppAuthIntent(attempt: AppAuthAttempt, doc: Document = document): void {
  doc.open();
  doc.write('<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="origin"><title>Connecting to Hosty</title></head><body></body></html>');
  doc.close();
  const policy = doc.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  // CSP host sources cannot represent IPv6 literals; the form target remains fixed to Core.
  // Other origins permit Core and this frozen app origin through the return redirect chain.
  const core = new URL(attempt.coreOrigin);
  const formAction = core.hostname.startsWith("[") ? "" : `form-action ${core.origin} 'self'; `;
  policy.content = `default-src 'none'; ${formAction}base-uri 'none'`;
  doc.head.append(policy);
  const form = doc.createElement("form");
  form.method = "POST";
  form.action = new URL(`/api/apps/${encodeURIComponent(attempt.appId)}/sign-in-intent`, attempt.coreOrigin).href;
  for (const [name, value] of Object.entries(appAuthFields(attempt))) {
    const input = doc.createElement("input"); input.type = "hidden"; input.name = name; input.value = value; form.append(input);
  }
  const notice = doc.createElement("p"); notice.textContent = "Connecting to Hosty…";
  doc.body.append(notice, form);
  form.submit();
}

/** App-only credentials. Embedded documents keep them for this tab on the app's own origin. */
let grant: { token: string; origin: string } | null = null;
let grantRevision = 0;
let recoveryPending = false;
const popupCancellations = new Set<() => void>();
export const APP_SESSION_ENDED = "hosty:app-session-ended";
export const NATIVE_APP_AUTH_RESULT = "hosty:native-auth-result";
export const APP_GRANT_STORAGE_KEY = "hosty.auth.app-grant";

function isEmbedded(): boolean {
  try { return window.self !== window.top; } catch { return true; }
}

/** Restore before the first identity probe; standalone documents use their first-party cookie. */
export function restoreAppGrant(): boolean {
  if (typeof window === "undefined") return false;
  if (grant?.origin === window.location.origin) return true;
  if (!isEmbedded()) return false;
  try {
    const token = window.sessionStorage.getItem(APP_GRANT_STORAGE_KEY);
    if (token) { grant = { token, origin: window.location.origin }; grantRevision++; }
  } catch {
    // Blocked storage leaves the in-memory transport available.
  }
  return grant?.origin === window.location.origin;
}

export function rememberAppGrant(token: string): void {
  grant = { token, origin: window.location.origin };
  grantRevision++;
  recoveryPending = false;
  if (isEmbedded()) {
    try { window.sessionStorage.setItem(APP_GRANT_STORAGE_KEY, token); } catch { /* In-memory fallback. */ }
  }
}

export function forgetAppGrant(): void {
  if (!grant) grantRevision++;
  discardAppGrant();
  clearAppAuthAttempts();
  for (const cancel of [...popupCancellations]) cancel();
  cancelActivityRenewal();
}
function discardAppGrant(): void {
  if (grant) grantRevision++;
  grant = null;
  recoveryPending = false;
  if (typeof window !== "undefined") {
    try { window.sessionStorage.removeItem(APP_GRANT_STORAGE_KEY); } catch { /* In-memory fallback. */ }
  }
}
/** Snapshot the grant generation so older probes cannot invalidate a renewed identity. */
export function appGrantRevision(): number { return grantRevision; }
/** Activity expiry keeps identity; only explicit identity rejection discards the credential. */
export function forgetRejectedAppGrant(code: unknown, expectedRevision = grantRevision): boolean {
  if (expectedRevision !== grantRevision) return false;
  if (typeof code !== "string" || !["token_invalid", "token_revoked", "token_expired", "token_app_mismatch"].includes(code)) return false;
  discardAppGrant();
  return true;
}
export function appSessionActive(): void { recoveryPending = false; }

/** Use for app-local API calls, including streams. Redirects cannot carry the credential away. */
export async function appFetch(input: string | URL, init: RequestInit = {}, recover = true): Promise<Response> {
  if (typeof window === "undefined") return fetch(input, init);
  const url = new URL(input, window.location.href);
  if (url.origin !== window.location.origin || url.username || url.password)
    throw new Error("App API requests must stay on this app's origin.");
  const current = grant?.origin === url.origin ? grant : null;
  const headers = new Headers(init.headers);
  if (current) headers.set("authorization", `Bearer ${current.token}`);
  const response = await fetch(input, { ...init, headers, credentials: "same-origin", redirect: "error" });
  if ((response.status === 401 || response.status === 403) && grant === current && !init.signal?.aborted) {
    const revision = grantRevision;
    const body = await response.clone().json().catch(() => null) as { code?: string } | null;
    if (grant !== current || grantRevision !== revision || init.signal?.aborted) return response;
    // Identity probes disable recovery, but a rejected grant must still be forgotten. Activity
    // expiry is different: the identity remains valid and the popup renews the same session.
    const rejected = forgetRejectedAppGrant(body?.code);
    if (response.status !== 401) return response;
    if (!rejected && recover && body?.code !== "reauth_required" && current) discardAppGrant();
    if (!recover) return response;
    if (activityConfig) {
      const renewed = waitForActivity(init.signal);
      window.dispatchEvent(new Event(APP_SESSION_ENDED));
      // A response may arrive while the originating click still has browser activation.
      // Otherwise the inline button owns the next attempt; background work never opens a popup.
      if (navigator.userActivation?.isActive) void renewAppActivity().catch(() => undefined);
      if (await renewed) return appFetch(input, init, false);
    } else if (!recoveryPending) {
      recoveryPending = true;
      window.dispatchEvent(new Event(APP_SESSION_ENDED));
    }
  }
  return response;
}

/** Refresh only the app-local, server-verified metadata for this frozen app/Core pair. */
export async function refreshAppAuthProtocol(openUrl: string, probePath = "/api/auth/identity", signal?: AbortSignal): Promise<AppAuthProtocol | null> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = window.setTimeout(abort, 4_000);
  try {
    const open = new URL(openUrl);
    const match = /^\/api\/apps\/([^/]+)\/open$/.exec(open.pathname);
    if (!match || !["http:", "https:"].includes(open.protocol) || open.username || open.password) return null;
    const response = await appFetch(probePath, { cache: "no-store", signal: controller.signal }, false);
    if (![200, 401].includes(response.status) || !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return null;
    const body = await response.json() as { recovery?: { appId?: unknown; corePublicOrigin?: unknown; appAuthProtocol?: unknown } };
    const recovery = body?.recovery;
    if (recovery?.appId !== decodeURIComponent(match[1]) || typeof recovery.corePublicOrigin !== "string") return null;
    const core = new URL(recovery.corePublicOrigin);
    if (core.origin !== open.origin || core.username || core.password || core.pathname !== "/" || core.search || core.hash) return null;
    if (controller.signal.aborted) return null;
    return acceptAppAuthProtocol(open.origin, recovery.appAuthProtocol === 2 ? 2 : recovery.appAuthProtocol === 1 ? 1 : null);
  } catch { return null; }
  finally { window.clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}

/** Must be called directly from a user gesture. Native hosts intercept before any request. */
export function openAppSignIn(openUrl: string, signal?: AbortSignal, appAuthProtocol: AppAuthProtocol = 2, native = false, probePath = "/api/auth/identity"): Promise<AppSignInResult> {
  let initialAttempt: AppAuthAttempt | null;
  try { initialAttempt = createAppAuthAttempt(openUrl, native ? "native" : "popup", appAuthProtocol); }
  catch (error) { return Promise.reject(error); }
  if (native) return openNativeAppSignIn(initialAttempt, signal);
  return new Promise((resolve, reject) => {
    let attempt: AppAuthAttempt | null = initialAttempt;
    initialAttempt = null;
    let popup: Window | null = null;
    let settled = false;
    let upgraded = false;
    let restartPoll: ReturnType<typeof setInterval> | undefined;
    const refreshController = new AbortController();
    const finish = (code?: string, error?: string) => {
      if (settled) return;
      settled = true;
      const proof = code && attempt ? { code, codeVerifier: attempt.codeVerifier } : null;
      attempt = null;
      refreshController.abort();
      window.removeEventListener("message", receive);
      signal?.removeEventListener("abort", abort);
      popupCancellations.delete(abort);
      window.clearTimeout(timer);
      clearInterval(closedCheck);
      clearInterval(restartPoll);
      popup?.close();
      if (proof) resolve(proof); else reject(new Error(error ?? "Sign-in was cancelled."));
    };
    const restart = async () => {
      // The correlated Core refusal carries no authority. The app server must verify v2
      // before the existing gesture-opened window receives an entirely fresh attempt.
      attempt = null;
      if (await refreshAppAuthProtocol(openUrl, probePath, refreshController.signal) !== 2) {
        if (!settled) finish(undefined, "Hosty sign-in protocol could not be verified. Please try again.");
        return;
      }
      if (settled || !popup || popup.closed) return;
      try { popup.location.href = "about:blank"; }
      catch { finish(undefined, "The app could not restart Hosty sign-in. Please try again."); return; }
      const deadline = Date.now() + 5_000;
      const submit = () => {
        if (settled) return;
        if (!popup || popup.closed) { finish(); return; }
        let doc: Document;
        try {
          // Access is possible only after the app-initiated blank navigation restores
          // this app's origin. Never write an intent into the old Core document.
          doc = popup.document;
          if (doc.URL !== "about:blank") throw new Error("Popup is still navigating.");
        } catch {
          if (Date.now() >= deadline) finish(undefined, "The app could not restart Hosty sign-in. Please try again.");
          return;
        }
        clearInterval(restartPoll);
        try { attempt = createAppAuthAttempt(openUrl, "popup", 2); submitAppAuthIntent(attempt, doc); }
        catch { finish(undefined, "The app could not restart Hosty sign-in. Please try again."); }
      };
      restartPoll = setInterval(submit, 20);
      submit();
    };
    const receive = (event: MessageEvent) => {
      if (!popup || !attempt || event.source !== popup || event.origin !== attempt.coreOrigin) return;
      const data = event.data;
      if (data?.type !== "hosty:app-auth-code" || data.state !== attempt.state) return;
      if (typeof data.error === "string") {
        if (data.error === "protocol_required" && attempt.protocol === 1 && !upgraded &&
            Object.keys(data).length === 3 && data.code === undefined) {
          upgraded = true;
          void restart();
        } else finish(undefined, "Hosty could not authorize this sign-in. Please try again.");
        return;
      }
      if (typeof data.code !== "string" || !data.code || data.code.length > 4096) return;
      finish(data.code);
    };
    const abort = () => finish();
    const timer = window.setTimeout(() => finish(undefined, "Sign-in timed out. Please try again."), 180_000);
    const closedCheck = setInterval(() => { if (popup?.closed) finish(); }, 500);
    window.addEventListener("message", receive);
    popupCancellations.add(abort);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { finish(); return; }
    // No await precedes window.open: browser activation belongs to this exact app gesture.
    popup = window.open(appAuthProtocol === 1 ? appAuthNavigationUrl(attempt!) : "about:blank", "_blank", "popup,width=520,height=700");
    if (!popup) { finish(undefined, "Allow the sign-in popup and try again."); return; }
    if (appAuthProtocol === 2) {
      try { submitAppAuthIntent(attempt!, popup.document); }
      catch { finish(undefined, "The app could not open the Hosty sign-in form. Please try again."); }
    }
  });
}

/** The native host preserves this document and returns only a correlated public result. */
function openNativeAppSignIn(attempt: AppAuthAttempt, signal?: AbortSignal): Promise<AppSignInResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (code?: string, error?: string) => {
      if (settled) return;
      settled = true;
      window.removeEventListener(NATIVE_APP_AUTH_RESULT, receive);
      signal?.removeEventListener("abort", abort);
      popupCancellations.delete(abort);
      window.clearTimeout(timer);
      if (code) resolve({ code, codeVerifier: attempt.codeVerifier });
      else reject(new Error(error ?? "Sign-in was cancelled."));
    };
    const receive = (event: Event) => {
      const data = (event as CustomEvent).detail;
      if (!data || data.state !== attempt.state) return;
      if (data.error && typeof data.error.code === "string") {
        finish(undefined, "Hosty could not authorize this sign-in. Please try again."); return;
      }
      if (typeof data.code !== "string" || !data.code || data.code.length > 4096) return;
      finish(data.code);
    };
    const abort = () => finish();
    const timer = window.setTimeout(() => finish(undefined, "Sign-in timed out. Please try again."), 180_000);
    window.addEventListener(NATIVE_APP_AUTH_RESULT, receive);
    popupCancellations.add(abort);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { finish(); return; }
    const url = new URL(appAuthNavigationUrl(attempt));
    url.searchParams.set("responseMode", "web_message");
    try { window.location.assign(url.href); }
    catch { finish(undefined, "The native host could not open Hosty sign-in. Please try again."); }
  });
}

export const APP_ACTIVITY_RENEWED = "hosty:app-activity-renewed";
export type AppActivityConfig = {
  openUrl: string;
  appAuthProtocol: AppAuthProtocol;
  native?: boolean;
  probePath?: string;
  activeUntil?: string | null;
  activityRequired?: boolean;
  exchangeCode: (result: AppSignInResult) => Promise<{ accessToken?: string; activeUntil?: string | null }>;
};
let activityConfig: AppActivityConfig | null = null;
let renewal: Promise<void> | null = null;
let renewalController: AbortController | null = null;
const waiting = new Set<(ok: boolean) => void>();

export function configureAppActivity(config: AppActivityConfig): () => void {
  activityConfig = config;
  return () => { if (activityConfig === config) { activityConfig = null; cancelActivityRenewal(); } };
}
export function updateAppActivity(activeUntil?: string | null, activityRequired?: boolean): void {
  if (activityConfig) { activityConfig.activeUntil = activeUntil; activityConfig.activityRequired = activityRequired; }
}
export function cancelActivityRenewal(): void { renewalController?.abort(); for (const done of [...waiting]) done(false); }
function waitForActivity(signal?: AbortSignal | null): Promise<boolean> {
  return new Promise(resolve => {
    const done = (ok: boolean) => { waiting.delete(done); signal?.removeEventListener("abort", abort); resolve(ok); };
    const abort = () => done(false);
    waiting.add(done);
    if (signal?.aborted) done(false); else signal?.addEventListener("abort", abort, { once: true });
  });
}
/** Call only in response to a user gesture. The original page is never navigated or reloaded. */
export function renewAppActivity(): Promise<void> {
  if (renewal) return renewal;
  const config = activityConfig;
  if (!config) return Promise.reject(new Error("App recovery is not configured."));
  const controller = new AbortController();
  const revision = grantRevision;
  renewalController = controller;
  const popup = openAppSignIn(config.openUrl, controller.signal, config.appAuthProtocol, config.native, config.probePath);
  renewal = popup.then(async proof => {
    if (config.appAuthProtocol === 1 && acceptAppAuthProtocol(new URL(config.openUrl).origin, 1) === null) config.appAuthProtocol = 2;
    const result = await config.exchangeCode(proof);
    if (controller.signal.aborted || activityConfig !== config || revision !== grantRevision)
      throw new Error("Sign-in was cancelled.");
    if (result.accessToken) rememberAppGrant(result.accessToken);
    config.activeUntil = result.activeUntil;
    recoveryPending = false;
    for (const done of [...waiting]) done(true);
    window.dispatchEvent(new Event(APP_ACTIVITY_RENEWED));
  }).catch(error => { cancelActivityRenewal(); throw error; }).finally(() => { renewal = null; renewalController = null; });
  return renewal;
}
export function appActivityNeedsRenewal(now = Date.now()): boolean {
  if (!activityConfig?.activityRequired) return false;
  const until = Date.parse(activityConfig.activeUntil ?? "");
  return !Number.isFinite(until) || until - now < 10 * 60_000;
}
