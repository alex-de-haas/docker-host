import type { AppSignInResult } from "./browser-auth";

type Exchange = { ok: boolean; body: Record<string, unknown> | null };

/** A one-use proof is submitted once; timeout or cancellation never retries it. */
export async function exchangeAppCode(path: string, proof: AppSignInResult, signal?: AbortSignal): Promise<Exchange> {
  const url = new URL(path, window.location.href);
  if (url.origin !== window.location.origin || url.username || url.password)
    throw new Error("App sign-in requests must stay on this app's origin.");
  if (signal?.aborted) throw new DOMException("Sign-in was cancelled.", "AbortError");
  const controller = new AbortController();
  let interrupt!: (error: Error) => void;
  const interrupted = new Promise<never>((_resolve, reject) => { interrupt = reject; });
  const abort = () => { controller.abort(); interrupt(new DOMException("Sign-in was cancelled.", "AbortError")); };
  signal?.addEventListener("abort", abort, { once: true });
  const timer = window.setTimeout(() => {
    controller.abort(); interrupt(new Error("Hosty sign-in connection timed out. Please try again."));
  }, 4_000);
  const operation = (async () => {
    const response = await fetch(url.href, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(proof), credentials: "same-origin", redirect: "error", signal: controller.signal });
    const value: unknown = await response.json().catch(() => null);
    const body = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
    return { ok: response.ok, body };
  })();
  try { return await Promise.race([operation, interrupted]); }
  finally { window.clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}
