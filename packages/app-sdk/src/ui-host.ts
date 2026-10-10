import { createPresentationRequestId, type UiClient } from "./ui";
import { UiError, panelKey, routeWithin, type PanelRef, type PanelTarget, type PresentationOptions, type PresentationResult,
  type UiBootstrap, type UiEnvironment, type UiEvent, type UiFrameSurface, type UiPanel, type UiResolvedPanel, type SurfaceReadiness } from "./ui-types";
import { DISCOVERY_TIMEOUT, failure, readUiMessage, uiPath, uiRequest, validId, validTarget, waitForPresentation, type UiMessage } from "./ui-transport";

export type UiTool = { key: string; target: PanelTarget; resolved: UiResolvedPanel; readiness: SurfaceReadiness; attention: number };
export type UiHostSnapshot = { bootstrap: UiBootstrap | null; catalog: UiPanel[]; tools: UiTool[];
  selected: PanelRef | null; expanded: boolean; width: number; error: { code: string; message: string } | null };
type Frame = { element: HTMLIFrameElement; surface: UiFrameSurface; generation: string; nonce: string | null;
  connected: boolean; actor: string | null; live: boolean; cleanup: () => void; waitForReadiness: () => void };
type Ledger = { input: string; result?: PresentationResult; pending?: Promise<PresentationResult>; frame?: Frame };
let documentHost: UiHost | null = null;

/** One top-level composition owner. All Core traffic goes through this app's authenticated adapter. */
export function createUiHost(options: { uiPath?: string; active?: boolean } = {}): UiHost {
  if (typeof window === "undefined" || window.parent !== window) throw new Error("A panel host belongs to a top-level browser document.");
  if (documentHost) throw new Error("A Hosty panel host already owns this document.");
  const host = new UiHost(uiPath(options.uiPath), options.active);
  documentHost = host;
  return host;
}

export class UiHost implements UiClient {
  private snapshot: UiHostSnapshot = { bootstrap: null, catalog: [], tools: [], selected: null, expanded: false, width: 360, error: null };
  private environment: UiEnvironment = { mode: "standalone", connection: "connecting" };
  private readonly windowId = createPresentationRequestId();
  private readonly listeners = new Set<() => void>();
  private readonly events = new Set<(event: UiEvent) => void>();
  private readonly frames = new Set<Frame>();
  private readonly ledger = new Map<string, Ledger>();
  private readonly toolQueues = new Map<string, Promise<PresentationResult>>();
  private selectionGeneration = 0;
  private activityGeneration = 0;
  private activityReady: boolean;
  private disposed = false;
  private workspace: object | null = null;
  private refreshing: Promise<void> | null = null;
  private readonly onMessage = (event: MessageEvent) => { void this.receive(event); };
  private readonly onFocus = () => { void this.refresh(); };
  constructor(private readonly path: string, private active = true) {
    this.activityReady = active;
    window.addEventListener("message", this.onMessage);
    window.addEventListener("focus", this.onFocus);
    if (active) void this.refresh(); else this.setEnvironment("blocked", "activity_required");
  }
  getEnvironment = () => this.environment;
  setActive(active: boolean) {
    if (this.disposed || this.active === active) return;
    this.active = active; this.activityReady = false;
    this.activityGeneration++; this.selectionGeneration++;
    this.refreshing = null; this.toolQueues.clear();
    for (const [key, entry] of this.ledger) if (entry.pending) this.ledger.delete(key);
    for (const frame of this.frames) {
      frame.connected = false; frame.actor = null; frame.nonce = null;
      frame.generation = createPresentationRequestId();
    }
    this.setEnvironment(active ? "connecting" : "blocked", active ? undefined : "activity_required");
    if (active) void this.refresh();
  }
  private checkActivity(generation: number, renewing = false) {
    if (this.disposed || !this.active || generation !== this.activityGeneration || !renewing && !this.activityReady)
      throw new UiError("activity_required", "Renew this app's activity before opening panels.");
  }
  claimWorkspace = (owner: object) => {
    if (this.workspace && this.workspace !== owner) throw new Error("Exactly one panel workspace may occupy this host.");
    this.workspace = owner;
    return () => { if (this.workspace === owner) this.workspace = null; };
  };
  getSnapshot = () => this.snapshot;
  subscribeSnapshot = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  subscribe = (listener: (event: UiEvent) => void) => {
    this.events.add(listener); listener({ type: "environment", value: this.environment }); return () => { this.events.delete(listener); };
  };
  private emit(event: UiEvent) { if (!this.disposed) for (const listener of this.events) listener(event); }
  private update(patch: Partial<UiHostSnapshot>) {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...patch }; for (const listener of this.listeners) listener();
  }
  private setEnvironment(connection: UiEnvironment["connection"], code?: string) {
    this.environment = { mode: "standalone", connection, ...(code ? { code } : {}) };
    this.emit({ type: "environment", value: this.environment });
  }
  private async bootstrap(generation = this.activityGeneration, renewing = false): Promise<UiBootstrap> {
    this.checkActivity(generation, renewing);
    const value = await uiRequest<UiBootstrap>(this.path, "bootstrap");
    this.checkActivity(generation, renewing);
    if (value.version !== 1 || !value.app?.installationId || !value.userId) throw new UiError("unsupported_app", "Unsupported panel metadata.");
    const previous = this.snapshot.bootstrap;
    if (previous && (previous.userId !== value.userId || previous.coreOrigin !== value.coreOrigin || previous.app.installationId !== value.app.installationId)) {
      this.ledger.clear(); this.toolQueues.clear();
      for (const frame of this.frames) {
        frame.connected = false; frame.actor = null; frame.nonce = null;
        frame.generation = createPresentationRequestId();
        this.post(frame, { type: "hosty:ui:probe-request" });
      }
      this.update({ tools: [], selected: null, expanded: false });
    }
    this.update({ bootstrap: value });
    return value;
  }
  refresh = (): Promise<void> => {
    if (!this.active || this.disposed) return Promise.resolve();
    if (this.refreshing) return this.refreshing;
    const generation = this.activityGeneration;
    const operation = (async () => {
      try {
        const own = await this.bootstrap(generation, true);
        this.checkActivity(generation, true);
        if (!own.canHost) { this.setEnvironment("unsupported", "app_permission_required"); this.update({ catalog: [], tools: [], selected: null, expanded: false }); return; }
        const catalog = await uiRequest<{ panels: UiPanel[] }>(this.path, "panels");
        this.checkActivity(generation, true);
        if (!Array.isArray(catalog.panels)) throw new UiError("ui_response_invalid", "Invalid panel catalog.");
        this.activityReady = true;
        this.update({ catalog: catalog.panels, error: null }); this.setEnvironment("connected");
        // Catalog disappearance/replacement is access loss, while temporary readiness loss retains drafts.
        const allowed = new Map(catalog.panels.map(p => [panelKey(p.panel), p]));
        this.update({ tools: this.snapshot.tools.map(tool => {
          const entry = allowed.get(tool.key);
          const invalid = !entry || !["running", "degraded", "unavailable", "starting", "stopping"].includes(entry.state);
          const surface = tool.resolved.surface;
          const changed = entry && surface && JSON.stringify(entry.framePolicy) !== JSON.stringify(surface.framePolicy);
          const moved = entry && surface && (entry.origin !== surface.origin || entry.endpoint !== surface.endpoint
            || !routeWithin(surface.route, entry.route));
          return invalid || changed || moved ? { ...tool, resolved: { ...tool.resolved, available: false, surface: null,
            state: !entry ? "access_unavailable" : changed ? "policy_changed" : moved ? "destination_changed" : entry.state } }
            : entry && surface ? { ...tool, resolved: { ...tool.resolved, available: entry.available, state: entry.state } } : tool;
        }) });
        for (const frame of this.frames) this.post(frame, { type: "hosty:ui:probe-request" });
      } catch (error) {
        if (!this.active || this.disposed || generation !== this.activityGeneration) return;
        const code = error instanceof UiError ? error.code : "ui_unavailable";
        this.update({ error: { code, message: error instanceof Error ? error.message : "Panel metadata is unavailable." } });
        this.setEnvironment(code.startsWith("unsupported") ? "unsupported" : "blocked", code);
      }
    })().finally(() => { if (this.refreshing === operation) this.refreshing = null; });
    this.refreshing = operation;
    return operation;
  };

  openSurface = (target: PanelTarget, options: PresentationOptions): Promise<PresentationResult> =>
    waitForPresentation(this.open(target, options, "local"), options.requestId, options.signal);

  private open(target: PanelTarget, options: PresentationOptions, source: string, frame?: Frame): Promise<PresentationResult> {
    const id = options.requestId;
    if (!this.active || !this.activityReady || this.disposed)
      return Promise.resolve({ status: "blocked", requestId: id, code: "activity_required" });
    const generation = this.activityGeneration;
    if (!validId(id) || !validTarget(target) || options.placement !== "side")
      return Promise.resolve({ status: "rejected", requestId: id, code: "invalid_presentation" });
    const key = `${source}:${id}`, input = JSON.stringify([target.panel.appId, target.panel.installationId, target.panel.panelId, target.route ?? null]);
    const existing = this.ledger.get(key);
    if (existing && existing.input !== input) return Promise.resolve({ status: "rejected", requestId: id, code: "request_conflict" });
    if (existing?.pending) return existing.pending;
    if ([...this.ledger.entries()].filter(([k, v]) => k.startsWith(source + ":") && v.pending).length >= 4)
      return Promise.resolve({ status: "blocked", requestId: id, code: "presentation_busy" });
    const entry: Ledger = { input, frame };
    const selectionGeneration = ++this.selectionGeneration;
    const currentSource = () => !frame || source === `${frame.surface.appId}:${frame.generation}:${frame.nonce}`;
    const toolKey = panelKey(target.panel), previous = this.toolQueues.get(toolKey);
    const operation = (async (): Promise<PresentationResult> => {
      if (previous) await previous;
      try {
        const own = await this.bootstrap(generation);
        this.checkActivity(generation);
        if (!own.canHost) throw new UiError("app_permission_required", "Allow this app to host panels.");
        if (frame && (!frame.live || !frame.connected || frame.actor !== own.userId || !currentSource())) throw new UiError("actor_mismatch", "Reconnect using the same account.");
        const resolved = await uiRequest<UiResolvedPanel>(this.path, "panels/resolve", target);
        this.checkActivity(generation);
        if (this.disposed || this.snapshot.bootstrap?.userId !== own.userId || this.snapshot.bootstrap?.coreOrigin !== own.coreOrigin || this.snapshot.bootstrap?.app.installationId !== own.app.installationId
          || frame && (!frame.live || !frame.connected || frame.actor !== own.userId || !currentSource())) throw new UiError("actor_mismatch", "The signed-in account changed.");
        if (!resolved.available || !resolved.surface) throw new UiError(resolved.state || "destination_unavailable", "The selected panel is unavailable.");
        const insecure = window.location.protocol === "https:" && new URL(resolved.surface.origin).protocol === "http:";
        if (selectionGeneration !== this.selectionGeneration)
          throw new UiError("presentation_superseded", "A newer panel action replaced this opening. Retry to open it again.");
        const old = this.snapshot.tools.find(t => t.key === toolKey);
        const same = old?.resolved.surface && JSON.stringify(old.resolved.surface) === JSON.stringify(resolved.surface);
        const tool: UiTool = { key: toolKey, target: resolved.target, resolved,
          readiness: insecure ? "unreported" : same ? old.readiness : "loading", attention: old?.attention ?? 0 };
        this.update({ tools: old ? this.snapshot.tools.map(t => t.key === toolKey ? tool : t) : [...this.snapshot.tools, tool], selected: target.panel, expanded: true });
        return { status: "opened", requestId: id, target: resolved.target, readiness: tool.readiness };
      } catch (error) { return failure(id, error); }
    })();
    entry.pending = operation; this.ledger.set(key, entry); this.toolQueues.set(toolKey, operation);
    void operation.then(result => {
      entry.pending = undefined; entry.result = result;
      if (this.toolQueues.get(toolKey) === operation) this.toolQueues.delete(toolKey);
      if (!frame && this.active && generation === this.activityGeneration) this.emit({ type: "presentation", value: result });
      const keys = [...this.ledger.keys()].filter(k => k.startsWith(source + ":"));
      for (const oldKey of keys.slice(0, Math.max(0, keys.length - 256))) if (!this.ledger.get(oldKey)?.pending) this.ledger.delete(oldKey);
    });
    return operation;
  }

  getPresentation = (id: string, options?: { signal?: AbortSignal }) => waitForPresentation(this.status(id, "local"), id, options?.signal);
  private async status(id: string, source: string, frame?: Frame): Promise<PresentationResult> {
    const generation = this.activityGeneration;
    try {
      const own = await this.bootstrap(generation);
      const check = () => {
        this.checkActivity(generation);
        if (!own.canHost) throw new UiError("app_permission_required", "Allow this app to host panels.");
        if (this.snapshot.bootstrap?.userId !== own.userId || this.snapshot.bootstrap?.coreOrigin !== own.coreOrigin
          || this.snapshot.bootstrap?.app.installationId !== own.app.installationId || frame && (!frame.live || !frame.connected || frame.actor !== own.userId
          || source !== `${frame.surface.appId}:${frame.generation}:${frame.nonce}`))
          throw new UiError("actor_mismatch", "Reconnect using the same account.");
      };
      check();
      const entry = this.ledger.get(`${source}:${id}`);
      const result = entry?.pending ? await entry.pending : entry?.result;
      check();
      if (result?.status === "opened") {
        const current = await uiRequest<UiResolvedPanel>(this.path, "panels/resolve", result.target);
        check();
        if (!current.available) return { status: "blocked", requestId: id, code: current.state };
        const tool = this.snapshot.tools.find(t => t.key === panelKey(result.target.panel));
        if (!tool || tool.target.route !== result.target.route || JSON.stringify(tool.resolved.surface) !== JSON.stringify(current.surface))
          return { status: "blocked", requestId: id, code: "destination_changed" };
        return { ...result, readiness: tool.readiness };
      }
      return result ?? { status: "unknown", requestId: id, code: "presentation_unknown" };
    } catch (error) { return failure(id, error); }
  }
  selectPanel = async (ref: PanelRef) => {
    const opened = this.snapshot.tools.find(t => t.key === panelKey(ref));
    return this.openSurface(opened?.target ?? { panel: ref }, { placement: "side", requestId: createPresentationRequestId() });
  };
  setExpanded = (expanded: boolean) => {
    if (expanded && (!this.active || !this.activityReady)) return;
    if (!expanded) this.selectionGeneration++;
    this.update({ expanded });
  };
  setWidth = (width: number) => { if (Number.isFinite(width)) this.update({ width: Math.min(800, Math.max(280, width)) }); };
  setAttention = (panel: PanelRef, attention: number) => this.update({ tools: this.snapshot.tools.map(t => t.key === panelKey(panel) ? { ...t, attention: Math.max(0, Math.floor(attention)) } : t) });
  reportSurfaceState = (_state: { route: string; state: "ready" | "blocked"; code?: string }) => {};

  registerFrame = (element: HTMLIFrameElement, surface: UiFrameSurface): (() => void) => {
    const frame: Frame = { element, surface, generation: createPresentationRequestId(), nonce: null, connected: false, actor: null, live: true, cleanup: () => {}, waitForReadiness: () => {} };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const forget = () => { for (const [key, entry] of this.ledger) if (entry.frame === frame) this.ledger.delete(key); };
    frame.waitForReadiness = () => {
      clearTimeout(timer); timer = setTimeout(() => {
        const tool = this.snapshot.tools.find(t => t.target.panel.panelId === frame.surface.panelId && t.target.panel.appId === frame.surface.appId);
        if (tool?.readiness === "loading") this.reportFrame(frame, "unreported");
      }, DISCOVERY_TIMEOUT);
    };
    const loaded = () => {
      forget();
      frame.generation = createPresentationRequestId(); frame.nonce = null; frame.connected = false; frame.actor = null;
      this.reportFrame(frame, "loading");
      this.post(frame, { type: "hosty:ui:probe-request" }); frame.waitForReadiness();
    };
    frame.cleanup = () => { frame.live = false; forget(); clearTimeout(timer); element.removeEventListener("load", loaded); this.frames.delete(frame); };
    this.frames.add(frame); element.addEventListener("load", loaded); loaded(); return frame.cleanup;
  };
  private post(frame: Frame, value: Record<string, unknown>) {
    if (!frame.live || this.disposed || !this.active || !this.activityReady) return;
    frame.element.contentWindow?.postMessage({ version: 1, hostWindowId: this.windowId, generation: frame.generation,
      childNonce: frame.nonce, ...value }, frame.surface.origin);
  }
  private reportFrame(frame: Frame, readiness: SurfaceReadiness) {
    if (!frame.surface.panelId || !this.active || !this.activityReady) return;
    const tools = this.snapshot.tools.map(t => t.resolved.surface?.appId === frame.surface.appId
      && t.target.panel.panelId === frame.surface.panelId
      && t.resolved.surface.installationId === frame.surface.installationId && t.resolved.surface.endpoint === frame.surface.endpoint
      && t.target.route === frame.surface.route ? { ...t, readiness } : t);
    this.update({ tools });
    for (const [key, entry] of this.ledger) {
      const result = entry.result;
      if (result?.status !== "opened") continue;
      const tool = tools.find(t => t.key === panelKey(result.target.panel) && t.target.route === result.target.route);
      if (!tool || tool.readiness === result.readiness) continue;
      entry.result = { ...result, readiness: tool.readiness };
      if (entry.frame?.live) this.post(entry.frame, { type: "hosty:ui:result", requestId: result.requestId, result: entry.result });
      else if (key.startsWith("local:")) this.emit({ type: "presentation", value: entry.result });
    }
  }
  private async receive(event: MessageEvent) {
    if (!this.active || !this.activityReady || this.disposed) return;
    const msg = readUiMessage(event.data); if (!msg) return;
    const frame = [...this.frames].find(f => f.live && f.element.contentWindow === event.source && f.surface.origin === event.origin);
    const own = this.snapshot.bootstrap;
    if (!frame || !own?.canHost) return;
    if (msg.type === "hosty:ui:probe" && validId(msg.childNonce) && Array.isArray(msg.versions) && msg.versions.includes(1)) {
      frame.nonce = msg.childNonce;
      this.post(frame, { type: "hosty:ui:offer" }); return;
    }
    if (msg.hostWindowId !== this.windowId || msg.generation !== frame.generation || msg.childNonce !== frame.nonce || !frame.nonce) return;
    // This is advisory state, accepted only from the mounted origin/document. It grants no authority.
    if (msg.type === "hosty:ui:auth-required") { this.reportFrame(frame, "auth-required"); return; }
    if (msg.type === "hosty:ui:accept") {
      frame.connected = msg.coreOrigin === own.coreOrigin && msg.userId === own.userId
        && msg.appId === frame.surface.appId && msg.installationId === frame.surface.installationId;
      frame.actor = frame.connected ? own.userId : null;
      if (frame.connected) { this.reportFrame(frame, "loading"); frame.waitForReadiness(); }
      this.post(frame, { type: "hosty:ui:connected", coreOrigin: own.coreOrigin, userId: own.userId,
        appId: own.app.appId, installationId: own.app.installationId, code: frame.connected ? null : "actor_mismatch", route: frame.surface.route });
      if (!frame.connected) this.reportFrame(frame, "auth-required");
      return;
    }
    if (!frame.connected) return;
    const source = `${frame.surface.appId}:${frame.generation}:${frame.nonce}`;
    if (msg.type === "hosty:ui:open" && validId(msg.requestId)) {
      const result = await this.open(msg.target as PanelTarget, { placement: msg.placement as "side", requestId: msg.requestId }, source, frame);
      if (source === `${frame.surface.appId}:${frame.generation}:${frame.nonce}`)
        this.post(frame, { type: "hosty:ui:result", requestId: msg.requestId, result });
    } else if (msg.type === "hosty:ui:status" && validId(msg.requestId)) {
      const result = await this.status(msg.requestId, source, frame);
      if (source === `${frame.surface.appId}:${frame.generation}:${frame.nonce}`)
        this.post(frame, { type: "hosty:ui:result", requestId: msg.requestId, result });
    } else if (msg.type === "hosty:ui:surface-state" && msg.route === frame.surface.route) {
      if (msg.state === "ready") this.reportFrame(frame, "ready");
      else if (msg.state === "auth-required" || msg.state === "blocked") this.reportFrame(frame, "auth-required");
    } else if (msg.type === "hosty:ui:dismiss") {
      const selected = this.snapshot.tools.find(t => this.snapshot.selected && t.key === panelKey(this.snapshot.selected));
      if (selected?.resolved.surface?.appId === frame.surface.appId && selected.target.panel.panelId === frame.surface.panelId && selected.target.route === frame.surface.route)
        window.dispatchEvent(new CustomEvent("hosty:ui:drawer-dismiss"));
    }
  }
  dispose = () => {
    this.disposed = true; for (const frame of this.frames) frame.cleanup();
    window.removeEventListener("message", this.onMessage); window.removeEventListener("focus", this.onFocus);
    this.listeners.clear(); this.events.clear(); this.ledger.clear();
    if (documentHost === this) documentHost = null;
  };
}
