import { createPresentationRequestId, type UiClient } from "./ui";
import { UiError, type PanelTarget, type PresentationOptions, type PresentationResult, type UiBootstrap, type UiEnvironment, type UiEvent } from "./ui-types";
import { DISCOVERY_TIMEOUT, failure, readUiMessage, uiRequest, validId, validTarget, waitForPresentation, type UiMessage } from "./ui-transport";

type PendingRequest = { input: string | null; operation: Promise<PresentationResult>;
  resolve: (result: PresentationResult) => void; waiters: number; sent: boolean };

/** Direct-child transport. Discovery carries no identity and never creates a fallback host. */
export class EmbeddedUiClient implements UiClient {
  private environment: UiEnvironment = { mode: "embedded", connection: "connecting" };
  private nonce = createPresentationRequestId();
  private readonly listeners = new Set<(event: UiEvent) => void>();
  private readonly pending = new Map<string, PendingRequest>();
  private channel: { origin: string; hostWindowId: string; generation: string; own: UiBootstrap } | null = null;
  private verifying: string | null = null;
  private disposed = false;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private retries: ReturnType<typeof setTimeout>[] = [];
  private state: { route: string; state: "ready" | "blocked"; code?: string } | null = null;
  private active = true;
  private offered = false;
  private readonly onMessage = (event: MessageEvent) => { void this.receive(event); };
  private readonly onFocus = () => { void this.recheck(); };
  private readonly onKey = (event: KeyboardEvent) => { if (this.active && !event.defaultPrevented && event.key === "Escape") this.post({ type: "hosty:ui:dismiss" }); };
  constructor(private readonly path: string) {
    window.addEventListener("message", this.onMessage);
    window.addEventListener("focus", this.onFocus);
    window.addEventListener("keydown", this.onKey);
    this.discover();
    if (window.parent !== window.top) this.setEnvironment("unsupported", "unsupported_nesting");
  }
  getEnvironment = () => this.environment;
  setActive(active: boolean) {
    if (this.active === active) return;
    if (!active) this.post({ type: "hosty:ui:auth-required" });
    this.active = active;
    this.channel = null; this.verifying = null; this.nonce = createPresentationRequestId();
    clearTimeout(this.deadline); this.retries.forEach(clearTimeout);
    if (!active) {
      for (const [requestId, entry] of this.pending) entry.resolve(entry.sent
        ? { status: "uncertain", requestId, code: "presentation_unknown" }
        : { status: "blocked", requestId, code: "activity_required" });
      this.pending.clear(); this.setEnvironment("blocked", "activity_required");
    } else { this.setEnvironment("connecting"); this.discover(); }
  }
  subscribe = (listener: (event: UiEvent) => void) => {
    this.listeners.add(listener); listener({ type: "environment", value: this.environment });
    return () => { this.listeners.delete(listener); };
  };
  private emit(event: UiEvent) { if (!this.disposed) for (const listener of this.listeners) listener(event); }
  private retirePending() {
    for (const [requestId, entry] of this.pending) entry.resolve(entry.sent
      ? { status: "uncertain", requestId, code: "presentation_unknown" }
      : { status: "unsupported", requestId, code: "host_unavailable" });
  }
  private setEnvironment(connection: UiEnvironment["connection"], code?: string) {
    if (this.disposed) return;
    this.environment = { mode: "embedded", connection, ...(code ? { code } : {}) };
    this.emit({ type: "environment", value: this.environment });
  }
  private probe() {
    if (this.active && !this.disposed && window.parent === window.top && !this.channel)
      window.parent.postMessage({ type: "hosty:ui:probe", version: 1, versions: [1], childNonce: this.nonce }, "*");
  }
  private discover() {
    clearTimeout(this.deadline); this.retries.forEach(clearTimeout);
    this.deadline = setTimeout(() => {
      if (this.environment.connection === "connecting") this.setEnvironment(this.offered ? "blocked" : "unsupported", "host_unavailable");
    }, DISCOVERY_TIMEOUT);
    this.probe();
    this.retries = [150, 500, 1500].map(delay => setTimeout(() => this.probe(), delay));
  }
  private post(value: Record<string, unknown>) {
    const channel = this.channel; if (!channel || !this.active || this.disposed) return;
    window.parent.postMessage({ version: 1, childNonce: this.nonce, hostWindowId: channel.hostWindowId, generation: channel.generation, ...value }, channel.origin);
  }
  private async recheck(): Promise<boolean> {
    const channel = this.channel; if (!this.active || !channel || this.environment.connection !== "connected") return false;
    try {
      const own = await uiRequest<UiBootstrap>(this.path, `bootstrap?parentOrigin=${encodeURIComponent(channel.origin)}`);
      if (this.disposed || this.channel !== channel) return false;
      if (own.userId !== channel.own.userId || own.coreOrigin !== channel.own.coreOrigin || own.app.installationId !== channel.own.app.installationId
        || own.peer?.installationId !== channel.own.peer?.installationId || own.peer?.appId !== channel.own.peer?.appId)
        throw new UiError("actor_mismatch", "Reconnect using the same Hosty account.");
      return true;
    } catch (error) {
      if (this.channel !== channel || this.disposed) return false;
      this.post({ type: "hosty:ui:surface-state", route: this.state?.route, state: "auth-required" });
      this.setEnvironment("blocked", error instanceof UiError ? error.code : "ui_unavailable"); return false;
    }
  }
  private async receive(event: MessageEvent) {
    const msg = readUiMessage(event.data);
    if (!msg || !this.active || event.source !== window.parent || window.parent !== window.top || event.origin === "null" || this.disposed) return;
    if (msg.type === "hosty:ui:probe-request") {
      if (this.channel && event.origin === this.channel.origin && (msg.generation !== this.channel.generation || msg.hostWindowId !== this.channel.hostWindowId)) {
        this.retirePending();
        this.channel = null; this.setEnvironment("connecting"); this.discover();
      }
      if (this.channel) { void this.recheck(); return; }
      this.probe(); return;
    }
    if (msg.childNonce !== this.nonce || !validId(msg.hostWindowId) || !validId(msg.generation)) return;
    if (msg.type === "hosty:ui:offer") {
      this.offered = true;
      if (this.channel?.origin === event.origin && this.channel.hostWindowId === msg.hostWindowId
        && this.channel.generation === msg.generation && this.environment.connection === "connected") return;
      const key = `${this.nonce}:${event.origin}:${msg.hostWindowId}:${msg.generation}`;
      if (this.verifying === key) return;
      this.verifying = key;
      try {
        const own = await uiRequest<UiBootstrap>(this.path, `bootstrap?parentOrigin=${encodeURIComponent(event.origin)}`);
        if (this.disposed || !this.active || this.verifying !== key) return;
        if (own.version !== 1 || !own.userId || !own.peer?.origins.includes(event.origin)) throw new UiError("host_untrusted", "Hosty cannot verify this host.");
        const previous = this.channel;
        if (previous && (previous.origin !== event.origin || previous.hostWindowId !== msg.hostWindowId || previous.generation !== msg.generation))
          this.retirePending();
        this.channel = { origin: event.origin, hostWindowId: msg.hostWindowId, generation: msg.generation, own };
        this.post({ type: "hosty:ui:accept", coreOrigin: own.coreOrigin, userId: own.userId, appId: own.app.appId, installationId: own.app.installationId });
      } catch (error) {
        if (this.disposed || !this.active || this.verifying !== key) return;
        const code = error instanceof UiError ? error.code : "ui_unavailable";
        this.setEnvironment(code.startsWith("unsupported") ? "unsupported" : "blocked", code);
      } finally { if (this.verifying === key) this.verifying = null; }
      return;
    }
    const channel = this.channel;
    if (!channel || event.origin !== channel.origin || msg.hostWindowId !== channel.hostWindowId || msg.generation !== channel.generation) return;
    if (msg.type === "hosty:ui:connected") {
      const own = channel.own;
      if (msg.code || msg.coreOrigin !== own.coreOrigin || msg.userId !== own.userId || msg.appId !== own.peer?.appId || msg.installationId !== own.peer?.installationId) {
        this.setEnvironment("blocked", "actor_mismatch"); return;
      }
      clearTimeout(this.deadline); this.setEnvironment("connected");
      if (this.state) this.reportSurfaceState(this.state);
      return;
    }
    if (this.environment.connection !== "connected") return;
    if (msg.type === "hosty:ui:result" && validId(msg.requestId) && validResult(msg.result, msg.requestId)) {
      const result = msg.result;
      this.pending.get(msg.requestId)?.resolve(result);
      this.emit({ type: "presentation", value: result });
    }
  }
  private async request(requestId: string, message: Record<string, unknown>, signal?: AbortSignal): Promise<PresentationResult> {
    if (!validId(requestId)) return { status: "rejected", requestId, code: "invalid_presentation" };
    if (!this.active) return { status: "blocked", requestId, code: "activity_required" };
    if (signal?.aborted) return { status: "uncertain", requestId, code: "presentation_unknown" };
    const target = message.target as PanelTarget | undefined;
    const input = target ? JSON.stringify([target.panel.appId, target.panel.installationId, target.panel.panelId, target.route ?? null]) : null;
    const existing = this.pending.get(requestId);
    if (existing) {
      if (input !== null && existing.input !== null && input !== existing.input)
        return { status: "rejected", requestId, code: "request_conflict" };
      // A status response cannot satisfy an opening dispatched later. Finish that query first;
      // status queried during an opening can simply share the in-flight operation's result.
      if (input !== null && existing.input === null) {
        const result = await this.wait(requestId, existing, signal);
        if (this.pending.get(requestId) === existing) return result;
        return this.request(requestId, message, signal);
      }
      return this.wait(requestId, existing, signal);
    }
    if (this.pending.size >= 4) return { status: "blocked", requestId, code: "presentation_busy" };
    let settle!: (result: PresentationResult) => void;
    const operation = new Promise<PresentationResult>(resolve => { settle = resolve; });
    const entry: PendingRequest = { input, operation, waiters: 0, sent: false, resolve: result => {
      if (this.pending.get(requestId) === entry) this.pending.delete(requestId);
      settle(result);
    } };
    // Reserve identity before asynchronous revalidation so racing callers cannot share
    // different payloads or overwrite each other's completion/cleanup handlers.
    this.pending.set(requestId, entry);
    void this.recheck().then(verified => {
      if (this.pending.get(requestId) !== entry) return;
      if (!verified) entry.resolve({ status: this.environment.connection === "blocked" ? "blocked" : "unsupported", requestId, code: this.environment.code ?? "host_unavailable" });
      else { entry.sent = true; this.post({ ...message, requestId }); }
    });
    return this.wait(requestId, entry, signal);
  }
  private wait(requestId: string, entry: PendingRequest, signal?: AbortSignal): Promise<PresentationResult> {
    entry.waiters++;
    return waitForPresentation(entry.operation, requestId, signal).finally(() => {
      // Ending a caller's wait does not cancel a sent message. Keep its reservation until
      // its response arrives or the channel is retired, so it cannot settle newer work.
      if (--entry.waiters === 0 && !entry.sent && this.pending.get(requestId) === entry) this.pending.delete(requestId);
    });
  }
  openSurface = (target: PanelTarget, options: PresentationOptions) => validTarget(target) && options.placement === "side"
    ? this.request(options.requestId, { type: "hosty:ui:open", target, placement: "side" }, options.signal)
    : Promise.resolve({ status: "rejected", requestId: options.requestId, code: "invalid_presentation" } as PresentationResult);
  getPresentation = (requestId: string, options?: { signal?: AbortSignal }) => this.request(requestId, { type: "hosty:ui:status" }, options?.signal);
  reportSurfaceState = (state: { route: string; state: "ready" | "blocked"; code?: string }) => {
    this.state = state;
    if (this.environment.connection === "connected") this.post({ type: "hosty:ui:surface-state", ...state });
  };
  dispose = () => {
    this.disposed = true; clearTimeout(this.deadline); this.retries.forEach(clearTimeout);
    window.removeEventListener("message", this.onMessage); window.removeEventListener("focus", this.onFocus); window.removeEventListener("keydown", this.onKey);
    for (const [id, entry] of this.pending) entry.resolve(failure(id, new UiError("host_unavailable", "Host disconnected.")));
    this.pending.clear(); this.listeners.clear();
  };
}

function validResult(value: unknown, id: string): value is PresentationResult {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<PresentationResult>;
  return v.requestId === id && (v.status === "opened" ? validTarget(v.target) && ["loading", "ready", "unreported", "auth-required"].includes(v.readiness!)
    : ["blocked", "unsupported", "rejected", "uncertain", "unknown"].includes(v.status!) && "code" in v && typeof v.code === "string");
}
