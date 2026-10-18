import type { AppContinuity } from "./continuity";

export const APP_CONTINUITY_UPDATED = "hosty:app-continuity-updated";
type Owner = { coreOrigin: string; authority: AppContinuity; probe: () => Promise<boolean> };
let owner: Owner | null = null;
let pending: Promise<boolean> | null = null;
let checkedAt = 0;
let valid = true;

/** One coordinator per app document; probes bypass appFetch's maintenance to avoid recursion. */
export async function ensureAppContinuity(force = false): Promise<boolean> {
  if (!owner) return true;
  if (pending) return pending;
  if (!force && Date.now() - checkedAt < Math.min(30_000, owner.authority.checkAfterSeconds * 1000)) return valid;
  const current = owner;
  pending = (async () => {
    // Browser policy may refuse the frame. Only the app's authoritative probe decides access.
    if (current.authority.mode === "browser") await maintainParent(current);
    const result = await current.probe().catch(() => false);
    if (owner !== current) return false;
    valid = result; checkedAt = Date.now();
    if (result) window.dispatchEvent(new Event(APP_CONTINUITY_UPDATED));
    return result;
  })().finally(() => { pending = null; });
  return pending;
}

export function configureAppContinuity(config: Owner): () => void {
  owner = config; checkedAt = 0; valid = true;
  let disposed = false;
  let failures = 0;
  let scheduleVersion = 0;
  let timer: ReturnType<typeof setTimeout>;
  const schedule = async (force = false) => {
    const version = ++scheduleVersion;
    clearTimeout(timer);
    const ok = await ensureAppContinuity(force);
    // Events can share one pending probe; only the latest waiter installs its next timer.
    if (disposed || version !== scheduleVersion) return;
    failures = ok ? 0 : Math.min(4, failures + 1);
    const seconds = ok ? config.authority.checkAfterSeconds : Math.min(300, 15 * 2 ** failures);
    timer = setTimeout(() => { void schedule(true); }, seconds * 1000 * (0.9 + Math.random() * 0.2));
  };
  const wake = () => { void schedule(); };
  const online = () => { void schedule(true); };
  window.addEventListener("focus", wake);
  window.addEventListener("online", online);
  document.addEventListener("visibilitychange", wake);
  void schedule(true);
  return () => {
    disposed = true; clearTimeout(timer);
    window.removeEventListener("focus", wake); window.removeEventListener("online", online);
    document.removeEventListener("visibilitychange", wake);
    if (owner === config) { owner = null; checkedAt = 0; }
  };
}

function maintainParent(config: Owner): Promise<void> {
  return new Promise(resolve => {
    const state = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, "0")).join("");
    const url = new URL("/api/auth/apps/continuity/frame", config.coreOrigin);
    url.searchParams.set("grantId", config.authority.grantId);
    url.searchParams.set("origin", window.location.origin); url.searchParams.set("state", state);
    const frame = document.createElement("iframe");
    frame.hidden = true; frame.title = "Hosty session maintenance"; frame.referrerPolicy = "no-referrer";
    const done = () => { clearTimeout(timer); window.removeEventListener("message", received); frame.remove(); resolve(); };
    const received = (event: MessageEvent) => {
      if (event.source === frame.contentWindow && event.origin === url.origin &&
          event.data?.type === "hosty:continuity-result" && event.data.state === state &&
          ["maintained", "unavailable"].includes(event.data.status)) done();
    };
    const timer = setTimeout(done, 4_000);
    window.addEventListener("message", received);
    frame.onload = () => frame.contentWindow?.postMessage({ type: "hosty:continuity-check", state }, url.origin);
    frame.onerror = done; frame.src = url.href; document.body.append(frame);
  });
}
