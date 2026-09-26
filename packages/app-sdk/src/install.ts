/** Framework-independent client for Core's reviewed, user-confirmed installation requests. */
export interface InstallSetting {
  key: string; type: string; defaultValue?: string | null; secret: boolean;
  required?: boolean; label?: string | null; description?: string | null;
  options?: { value: string; label: string }[] | null;
}
export interface InstallPlan {
  appId: string; displayName: string; description?: string | null; action: string;
  planId?: string | null; targetVersion: string; targetRuntime: string; targetRuntimeType: string;
  targetManifestDigest: string; manifestPath: string; defaultAutostart?: boolean;
  system?: boolean; corePermissions?: string[]; requestedRoles?: string[];
  permissionDescriptions?: Record<string, string>; roleDescriptions?: Record<string, string>;
  runtimeProfiles?: { key: string; type: string; default: boolean; development?: boolean }[];
  settings: InstallSetting[];
}
export interface InstallationSource {
  manifestPath?: string; feedsUrl?: string; feedId?: string; selectedRuntime?: string;
  updateAppId?: string; planDigest?: string;
}
export interface InstallationRequest {
  id: string; status: "draft" | "pending" | "executing" | "succeeded" | "denied" | "failed";
  plan: InstallPlan | null;
  approvalUrl: string; expiresAt: string; error?: string | null;
}
export interface InstallationClient {
  prepare(source: InstallationSource): Promise<InstallationRequest>;
  submit(id: string, settings: Record<string, string | null>, autostart: boolean): Promise<InstallationRequest>;
  status(id: string): Promise<InstallationRequest>;
}
export class InstallationError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}
export function createInstallationClient(options: {
  /** App-local server adapter by default; Shell may use Core's browser-session transport. */
  baseUrl?: string;
  request?: (url: string, body?: unknown, method?: string) => Promise<Response>;
} = {}): InstallationClient {
  const base = (options.baseUrl ?? "/api/hosty/installations").replace(/\/$/, "");
  const request = options.request ?? ((url, body, method = "POST") => fetch(url, {
    method, credentials: "same-origin", cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  async function call(path: string, body?: unknown, method = "POST"): Promise<InstallationRequest> {
    const response = await request(`${base}${path}`, body, method);
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new InstallationError(data?.message ?? `Core returned ${response.status}.`, response.status, data?.code);
    if (!data || typeof data.id !== "string" || typeof data.approvalUrl !== "string" || typeof data.status !== "string")
      throw new InstallationError("Core returned an invalid installation request.", 502, "response_invalid");
    return data as InstallationRequest;
  }
  return {
    prepare: source => call("", source),
    submit: (id, settings, autostart) => call(`/${encodeURIComponent(id)}/submit`, { settings, autostart }),
    status: id => call(`/${encodeURIComponent(id)}`, undefined, "GET"),
  };
}

export interface InstallationState {
  request: InstallationRequest | null; busy: boolean; error: string | null;
}
/** Reusable state flow for custom UIs, independent of React. Never automatically retries a mutation. */
export class InstallationFlow {
  private state: InstallationState = { request: null, busy: false, error: null };
  private listeners = new Set<() => void>();
  private generation = 0;
  private disposed = false;
  constructor(private readonly client: InstallationClient) {}
  snapshot = (): InstallationState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private set(state: InstallationState) {
    if (this.disposed) return;
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  clearReview() {
    if (this.state.request && this.state.request.status !== "draft") return;
    this.generation++;
    this.set({ request: null, busy: false, error: null });
  }
  cancelPending() { this.generation++; }
  dispose() { this.disposed = true; this.generation++; this.listeners.clear(); }
  async review(source: InstallationSource): Promise<void> {
    if (this.state.request && this.state.request.status !== "draft") return;
    const generation = ++this.generation;
    this.set({ request: null, busy: true, error: null });
    try {
      const request = await this.client.prepare(source);
      if (generation === this.generation) this.set({ request, busy: false, error: null });
    } catch (error) {
      if (generation === this.generation) this.set({ request: null, busy: false, error: message(error) });
    }
  }
  async submit(settings: Record<string, string | null>, autostart: boolean): Promise<InstallationRequest | null> {
    if (this.state.busy || this.state.request?.status !== "draft") return null;
    const id = this.state.request.id;
    const generation = this.generation;
    this.set({ ...this.state, busy: true, error: null });
    try {
      const request = await this.client.submit(id, settings, autostart);
      if (generation !== this.generation) return null;
      this.set({ request, busy: false, error: null });
      return request;
    } catch (error) {
      // A lost response may mean the request was already frozen. Recover by reading its status,
      // not by sending another submit or creating a second installation.
      try {
        const request = await this.client.status(id);
        if (generation !== this.generation) return null;
        this.set({ request, busy: false, error: request.status === "draft" ? message(error) : null });
        return request.status === "draft" ? null : request;
      } catch {
        if (generation === this.generation) this.set({ ...this.state, busy: false, error: message(error) });
        return null;
      }
    }
  }
  async refresh(): Promise<void> {
    if (!this.state.request || this.state.busy) return;
    const id = this.state.request.id;
    const generation = this.generation;
    try {
      const request = await this.client.status(id);
      if (generation === this.generation) this.set({ request, busy: false, error: request.error ?? null });
    } catch (error) {
      if (generation === this.generation) this.set({ ...this.state, error: message(error) });
    }
  }
}
function message(error: unknown) { return error instanceof Error ? error.message : "Installation request failed."; }

/** Open synchronously in a click handler, before awaiting plan/submit requests. */
export function openInstallationConfirmation(): Window | null {
  return window.open("about:blank", "_blank", "popup,width=640,height=720");
}
export function showInstallationConfirmation(popup: Window | null, request: InstallationRequest): void {
  const url = new URL(request.approvalUrl);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Invalid Core confirmation URL.");
  if (popup && !popup.closed) {
    popup.opener = null;
    popup.location.replace(url.href);
  }
}
