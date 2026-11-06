import { appFetch } from "@hosty-sdk/app/browser-auth";
import type { App, User } from "./model";
export async function coreRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await appFetch(`/api/core${path}`, { ...init, credentials: "same-origin", cache: "no-store" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || `Core returned ${response.status}.`);
  }
  return response.json();
}
export async function readDesktop(signal?: AbortSignal): Promise<{ user: User; apps: App[] }> {
  const session = await coreRequest<{ authenticated: boolean; user?: User }>("/api/auth/session", { signal });
  if (!session.authenticated || !session.user) throw new Error("Sign in through Hosty to open your desktop.");
  const response = await coreRequest<{ apps: App[] }>("/api/apps", { signal });
  return { user: session.user, apps: response.apps };
}
let mutationQueue: Promise<unknown> = Promise.resolve();
export function desktopMutation<T>(path: string, body: unknown, timeoutMs = 10 * 60_000): Promise<T> {
  // Serialize acquisition and use of the shared CSRF cookie across all window actions.
  const operation = mutationQueue.catch(() => {}).then(async () => {
    const signal = AbortSignal.timeout(timeoutMs);
    const { token } = await coreRequest<{ token: string }>("/api/auth/csrf", { signal });
    const response = await appFetch(path, { method: "POST", signal, credentials: "same-origin", cache: "no-store",
      headers: { "Content-Type": "application/json", "X-Hosty-CSRF": token }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || `Desktop returned ${response.status}.`);
    return result as T;
  });
  mutationQueue = operation;
  return operation;
}
export function lifecycle(appId: string, action: "start" | "stop" | "restart"): Promise<unknown> {
  return desktopMutation(`/api/core/api/apps/${encodeURIComponent(appId)}/${action}`, {});
}
