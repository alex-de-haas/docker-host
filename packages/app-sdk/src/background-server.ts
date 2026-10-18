import { ProviderError } from "@hosty-sdk/app/providers";
import type { ProviderServerOptions } from "@hosty-sdk/app/providers/server";

/** An explicit Core delegation reference. Keep this client and its credentials on the server. */
export class BackgroundGrantClient {
  private credential?: { accessToken: string; expiresAt: string };
  private pending?: Promise<string>;
  private readonly origin: URL;
  private readonly appId: string;
  private readonly service: string;
  constructor(private readonly grantId: string, private readonly scopeId: string, options: ProviderServerOptions = {}) {
    this.origin = new URL(options.coreOrigin ?? process.env.HOSTY_CORE_ORIGIN ?? "http://127.0.0.1:7070");
    this.appId = options.appId ?? process.env.HOSTY_APP_ID ?? "";
    this.service = options.serviceToken ?? process.env.HOSTY_APP_SERVICE_TOKEN ?? "";
    if (!this.appId || !this.service || !grantId || !scopeId) throw new Error("An app service identity and explicit background grant/scope references are required.");
  }
  /** Coalesces issuance; each protected dispatch still validates the delegation online in Core. */
  token(): Promise<string> {
    if (this.credential && Date.parse(this.credential.expiresAt) > Date.now() + 30_000) return Promise.resolve(this.credential.accessToken);
    if (this.pending) return this.pending;
    this.pending = (async () => {
      const response = await fetch(new URL(`/api/internal/apps/${encodeURIComponent(this.appId)}/background/token`, this.origin), {
        method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${this.service}`, "content-type": "application/json" },
        body: JSON.stringify({ grantId: this.grantId, scopeId: this.scopeId }),
      });
      const body = await response.json();
      if (!response.ok) throw new ProviderError(body.code ?? "background_denied", body.message ?? "Background access is unavailable.", response.status);
      if (typeof body.accessToken !== "string" || !Number.isFinite(Date.parse(body.expiresAt))) throw new Error("Invalid background credential response.");
      this.credential = body;
      return body.accessToken as string;
    })().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  /** Sends one operation. No automatic replay of a possibly completed mutation. */
  async core(path: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin.origin || !url.pathname.startsWith("/api/apps/") || url.username || url.password)
      throw new Error("Use a Core app operation path.");
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.service}`);
    headers.set("X-Hosty-App-Identity", await this.token());
    return fetch(url, { ...init, headers, redirect: "error", cache: "no-store" });
  }
}
