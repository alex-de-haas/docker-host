"use client";

export type Provider = { appId: string; displayName: string; url: string | null; running: boolean };

export type Settings = {
  systemPrompt: string;
  mcpProviders: Record<string, boolean>;
  mcpAutoAllow: Record<string, boolean>;
};

export type SettingsResponse = {
  settings: Settings;
  providers: Provider[];
  discovery: string;
  harness?: { name?: string; capabilities?: { liveReconfigure?: boolean } };
};

/**
 * Every request is relative and same-origin.
 *
 * Deliberately: this page is a static export, and an absolute origin resolved at build time is the
 * bug the telemetry UI already shipped once — `next build` baked a localhost origin into static
 * layouts, so the bundle worked only on the machine that built it. Relative means the page works
 * from whatever origin the gateway is actually reached at, embedded or standalone.
 *
 * `credentials: "include"` because the Hosty app session is a cookie the gateway set: the page
 * authenticates as the operator who opened it, exactly as every other embedded Hosty page does.
 */
async function call(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: "include",
    headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message || `Request failed (${response.status}).`);
  }
  return response;
}

/**
 * Trades the launch code Shell put on the URL for this app's session cookie, once, before anything
 * else is fetched.
 *
 * The code is removed from the address bar afterwards: it is single-use, so leaving it there makes
 * a refresh look broken and puts a spent credential in the operator's history.
 */
export async function establishSession(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  if (!code) {
    return;
  }

  try {
    await call("/app-code", { method: "POST", body: JSON.stringify({ code }) });
  } finally {
    params.delete("code");
    const query = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  }
}

export async function loadSettings(): Promise<SettingsResponse> {
  return (await call("/settings")).json() as Promise<SettingsResponse>;
}

export async function saveSettings(patch: Partial<Settings>): Promise<SettingsResponse> {
  return (await call("/settings", { method: "PUT", body: JSON.stringify(patch) })).json() as Promise<SettingsResponse>;
}
