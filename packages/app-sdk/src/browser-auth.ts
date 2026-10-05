/** App-only credentials. Embedded documents keep them for this tab on the app's own origin. */
let grant: { token: string; origin: string } | null = null;
let grantRevision = 0;
let recoveryPending = false;
export const APP_SESSION_ENDED = "hosty:app-session-ended";
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
  forgetAppGrant();
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
    if (!rejected && recover && body?.code !== "reauth_required" && current) forgetAppGrant();
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

/** Must be called directly from a user gesture. The popup belongs to this app frame, not Shell. */
export function openAppSignIn(openUrl: string, signal?: AbortSignal): Promise<string> {
  const url = new URL(openUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    return Promise.reject(new Error("Hosty sign-in URL is invalid."));
  const state = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, "0")).join("");
  url.searchParams.set("responseMode", "web_message");
  url.searchParams.set("state", state);
  return new Promise((resolve, reject) => {
    let popup: Window | null = null;
    let settled = false;
    const finish = (code?: string, error?: string) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", receive);
      signal?.removeEventListener("abort", abort);
      window.clearTimeout(timer);
      clearInterval(closedCheck);
      popup?.close();
      if (code) resolve(code); else reject(new Error(error ?? "Sign-in was cancelled."));
    };
    const receive = (event: MessageEvent) => {
      if (!popup || event.source !== popup || event.origin !== url.origin) return;
      const data = event.data;
      if (data?.type !== "hosty:app-auth-code" || data.state !== state ||
          typeof data.code !== "string" || !data.code || data.code.length > 4096) return;
      finish(data.code);
    };
    const abort = () => finish();
    const timer = window.setTimeout(() => finish(undefined, "Sign-in timed out. Please try again."), 180_000);
    const closedCheck = setInterval(() => { if (popup?.closed) finish(); }, 500);
    window.addEventListener("message", receive);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { finish(); return; }
    popup = window.open(url.href, "_blank", "popup,width=520,height=700");
    if (!popup) finish(undefined, "Allow the sign-in popup and try again.");
  });
}

export const APP_ACTIVITY_RENEWED = "hosty:app-activity-renewed";
export type AppActivityConfig = {
  openUrl: string;
  activeUntil?: string | null;
  activityRequired?: boolean;
  exchangeCode: (code: string) => Promise<{ accessToken?: string; activeUntil?: string | null }>;
};
let activityConfig: AppActivityConfig | null = null;
let renewal: Promise<void> | null = null;
const waiting = new Set<(ok: boolean) => void>();

export function configureAppActivity(config: AppActivityConfig): () => void {
  activityConfig = config;
  return () => { if (activityConfig === config) { activityConfig = null; cancelActivityRenewal(); } };
}
export function updateAppActivity(activeUntil?: string | null, activityRequired?: boolean): void {
  if (activityConfig) { activityConfig.activeUntil = activeUntil; activityConfig.activityRequired = activityRequired; }
}
export function cancelActivityRenewal(): void { for (const done of [...waiting]) done(false); }
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
  const popup = openAppSignIn(config.openUrl);
  renewal = popup.then(async code => {
    const result = await config.exchangeCode(code);
    if (result.accessToken) rememberAppGrant(result.accessToken);
    config.activeUntil = result.activeUntil;
    recoveryPending = false;
    for (const done of [...waiting]) done(true);
    window.dispatchEvent(new Event(APP_ACTIVITY_RENEWED));
  }).catch(error => { cancelActivityRenewal(); throw error; }).finally(() => { renewal = null; });
  return renewal;
}
export function appActivityNeedsRenewal(now = Date.now()): boolean {
  if (!activityConfig?.activityRequired) return false;
  const until = Date.parse(activityConfig.activeUntil ?? "");
  return !Number.isFinite(until) || until - now < 10 * 60_000;
}
