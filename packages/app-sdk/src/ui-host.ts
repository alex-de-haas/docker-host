import { UiCompositionModel, validChromeOverrides, withChromeHints } from "./ui-composition";
import { DEFAULT_WORKSPACE, ROOT_VIEW, workspace, type UiPresentation, type UiWorkspace, type UiWorkspaceSnapshot,
  type UiWorkspaceRenderer, type UiViewDescriptor, type UiPlacementResolver } from "./ui-workspaces";
export type { UiWorkspaceRenderer, UiViewDescriptor, UiPlacementResolver, UiPresentation } from "./ui-workspaces";
import { UI_COMPOSITION_CAPABILITY, type UiChromeOverrides, type UiActionOptions, type UiActionResult, type UiNavigationTarget, type UiResolvedNavigation } from "./ui-types";
import { createPresentationRequestId, type UiClient } from "./ui";
import { UiError, panelKey, routeWithin, type PanelRef, type PanelTarget, type PresentationOptions, type PresentationResult,
  type UiBootstrap, type UiEnvironment, type UiEvent, type UiFrameSurface, type UiPanel, type UiResolvedPanel, type SurfaceReadiness } from "./ui-types";
import { canonicalSurfaceRoute, DISCOVERY_TIMEOUT, failure, readUiMessage, uiPath, uiRequest, validId, validTarget, waitForPresentation, type UiMessage } from "./ui-transport";

export type UiTool = UiPresentation & { panelSurface: UiFrameSurface; navigationRoot?: string };
export type UiHostSnapshot = { bootstrap: UiBootstrap | null; catalog: UiPanel[]; tools: UiTool[];
  selected: PanelRef | null; selectedPresentationId?: string | null; workspaces?: UiWorkspaceSnapshot[]; expanded: boolean; width: number; error: { code: string; message: string } | null };
type Frame = { element: HTMLIFrameElement; surface: UiFrameSurface; generation: string; nonce: string | null;
  connected: boolean; actor: string | null; live: boolean; cleanup: () => void; waitForReadiness: () => void;
  routeReport?: { route: string | null; pending?: Promise<void> };
  onConnection?: (connected: boolean) => void; view: UiViewDescriptor; chrome: UiChromeOverrides; policyRevision: number; composition: boolean };
type Ledger = { input: string; result?: PresentationResult; pending?: Promise<PresentationResult>; frame?: Frame; openingSurface?: UiFrameSurface };
function immutable<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
let documentHost: UiHost | null = null;

/** One top-level composition owner. All Core traffic goes through this app's authenticated adapter. */
export function createUiHost(options: { uiPath?: string; active?: boolean; chrome?: UiChromeOverrides } = {}): UiHost {
  if (typeof window === "undefined" || window.parent !== window) throw new Error("A panel host belongs to a top-level browser document.");
  if (documentHost) throw new Error("A Hosty panel host already owns this document.");
  const host = new UiHost(uiPath(options.uiPath), options.active, options.chrome);
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
  private readonly viewChrome = new Map<string, UiChromeOverrides>();
  private readonly ledger = new Map<string, Ledger>();
  private readonly toolQueues = new Map<string, Promise<PresentationResult>>();
  private readonly moves = new Map<string, AbortController>();
  private readonly rendererWork = new Map<AbortController, { check: () => void; frame?: Frame }>();
  readonly composition: UiCompositionModel;
  private readonly workspaces = new Map<string, UiWorkspace>([[DEFAULT_WORKSPACE, workspace(DEFAULT_WORKSPACE)]]);
  private placement?: UiPlacementResolver;
  private readonly actions = new Map<string, { input: string; pending?: Promise<UiActionResult>; result?: UiActionResult; frame?: Frame }>();
  private focusSequence = 0;
  private activityGeneration = 0;
  private activityReady: boolean;
  private disposed = false;
  private refreshing: Promise<void> | null = null;
  private readonly onMessage = (event: MessageEvent) => { void this.receive(event); };
  private readonly onFocus = () => { void this.refresh(); };
  constructor(private readonly path: string, private active = true, chrome: UiChromeOverrides = {}) {
    this.composition = new UiCompositionModel(path, "standalone", chrome);
    this.composition.attachRouter();
    this.composition.subscribeChrome(() => {
      if (!this.getChrome().tools.enabled) for (const state of this.workspaces.values()) this.collapseWorkspace(state.workspaceId);
      for (const frame of this.frames) if (frame.connected && frame.composition) this.publishPolicy(frame);
    });
    this.activityReady = active;
    window.addEventListener("message", this.onMessage);
    window.addEventListener("focus", this.onFocus);
    if (active) void this.refresh(); else this.setEnvironment("blocked", "activity_required");
  }
  getEnvironment = () => this.environment;
  getChrome = () => this.composition.getChrome();
  subscribeChrome = (listener: () => void) => this.composition.subscribeChrome(listener);
  getNavigation = () => this.composition.getNavigation();
  subscribeNavigation = (listener: () => void) => this.composition.subscribeNavigation(listener);
  setActive(active: boolean) {
    if (this.disposed || this.active === active) return;
    for (const move of this.moves.values()) move.abort();
    this.active = active; this.activityReady = false;
    this.activityGeneration++; for (const state of this.workspaces.values()) state.generation++;
    this.invalidateRendererWork();
    this.composition.resetNavigation(); this.actions.clear();
    this.refreshing = null; this.toolQueues.clear();
    for (const [key, entry] of this.ledger) if (entry.pending || entry.frame) this.ledger.delete(key);
    for (const frame of this.frames) {
      frame.connected = false; frame.actor = null; frame.nonce = null;
      frame.onConnection?.(false);
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
    const state = this.workspaces.get(DEFAULT_WORKSPACE)!;
    if (state.renderer || state.owner && state.owner !== owner) throw new Error("Exactly one renderer may occupy a workspace.");
    state.owner = owner;
    return () => { if (state.owner === owner) state.owner = undefined; };
  };
  registerWorkspace = ({ workspaceId, renderer }: { workspaceId: string; renderer: UiWorkspaceRenderer }) => {
    if (!workspaceId || workspaceId.length > 256) throw new Error("Invalid workspace ID.");
    const state = this.workspaces.get(workspaceId) ?? workspace(workspaceId);
    if (state.renderer && state.renderer !== renderer) throw new Error("A workspace already has a renderer.");
    state.renderer = renderer; this.workspaces.set(workspaceId, state); this.publishWorkspaces();
    return () => {
      if (!this.disposed && this.snapshot.tools.some(t => t.workspaceId === workspaceId)) throw new Error("Close or move presentations before disposing their workspace.");
      if (state.renderer === renderer) {
        state.generation++; this.invalidateRendererWork();
        state.renderer = undefined; this.publishWorkspaces();
      }
    };
  };
  private publishWorkspaces() {
    const state = this.workspaces.get(DEFAULT_WORKSPACE)!;
    const selected = this.snapshot.tools.find(t => t.presentationId === state.selectedId);
    this.update({ selected: selected?.target.panel ?? null, selectedPresentationId: state.selectedId,
      expanded: state.expanded, width: state.width,
      workspaces: [...this.workspaces.values()].map(({ workspaceId, selectedId, expanded, width }) => ({ workspaceId, selectedId, expanded, width })) });
  }
  setPlacementResolver = (resolver?: UiPlacementResolver) => { this.placement = resolver; };
  getViewChrome = (viewId: string): UiChromeOverrides | undefined => {
    const chrome = this.viewChrome.get(viewId) ?? [...this.frames].find(frame => frame.view.viewId === viewId)?.chrome;
    return chrome ? structuredClone(chrome) : undefined;
  };
  setViewChrome = (viewId: string, overrides: UiChromeOverrides) => {
    if (!validChromeOverrides(overrides)) throw new Error("Invalid chrome policy.");
    if (viewId === ROOT_VIEW) { this.composition.setHostPolicy("root", this.getChrome().hostRevision + 1, overrides, false); return; }
    const frame = [...this.frames].find(f => f.view.viewId === viewId);
    if (!frame) throw new Error("Unknown view.");
    frame.chrome = structuredClone(overrides); this.viewChrome.set(viewId, frame.chrome); this.publishPolicy(frame);
  };
  private publishPolicy(frame: Frame) {
    if (!frame.composition || !frame.connected) return;
    this.post(frame, { type: "hosty:ui:chrome", revision: ++frame.policyRevision, chrome: frame.chrome,
      rootDisabled: !this.getChrome().tools.enabled, endpoint: frame.surface.endpoint });
  }
  private requireTools(frame?: Frame) {
    if (!this.getChrome().tools.enabled || frame?.chrome.tools?.enabled === false)
      throw new UiError("tools_disabled", "Tools are disabled in this view.");
  }
  focusPresentation = (id: string) => {
    const tool = this.snapshot.tools.find(t => t.presentationId === id);
    if (!tool) return false;
    this.requireTools();
    const state = this.workspaces.get(tool.workspaceId)!;
    state.generation++; state.selectedId = id; state.expanded = true;
    this.update({ tools: this.snapshot.tools.map(t => t === tool ? { ...t, focusedAt: ++this.focusSequence } : t) });
    this.publishWorkspaces(); state.renderer?.focus(id); return true;
  };
  collapseWorkspace = (id: string) => {
    const state = this.workspaces.get(id); if (!state) return;
    state.generation++; state.expanded = false; state.renderer?.collapse(); this.publishWorkspaces();
  };
  closePresentation = (id: string) => { this.releasePresentation(id); };
  private releasePresentation(id: string, supersede = true) {
    const tool = this.snapshot.tools.find(t => t.presentationId === id); if (!tool) return;
    this.moves.get(id)?.abort();
    const state = this.workspaces.get(tool.workspaceId)!;
    for (const frame of this.frames) if (frame.view.presentationId === id) frame.cleanup();
    if (supersede) state.generation++;
    state.renderer?.release(id);
    this.update({ tools: this.snapshot.tools.filter(t => t !== tool) });
    if (state.selectedId === id) { state.selectedId = null; state.expanded = false; }
    this.publishWorkspaces();
  }
  private resetPresentations() {
    for (const tool of this.snapshot.tools) this.closePresentation(tool.presentationId);
    for (const state of this.workspaces.values()) {
      state.selectedId = null; state.expanded = false; state.generation++; state.renderer?.collapse();
    }
    this.publishWorkspaces();
  }
  movePresentation = async (id: string, workspaceId: string): Promise<boolean> => {
    this.requireTools();
    const tool = this.snapshot.tools.find(t => t.presentationId === id), next = this.workspaces.get(workspaceId);
    if (!tool || !next?.renderer || this.moves.has(id)) return false;
    const previous = this.workspaces.get(tool.workspaceId)!;
    if (previous === next) return true;
    if (!previous.renderer?.frameLayer || previous.renderer.frameLayer !== next.renderer.frameLayer) return false;
    const activity = this.activityGeneration, generation = ++next.generation, renderer = next.renderer;
    this.invalidateRendererWork();
    const moved = { ...tool, workspaceId }, controller = new AbortController();
    const retainedSource = () => this.snapshot.tools.find(t => t.presentationId === id && t.workspaceId === tool.workspaceId && t.resolved.surface);
    this.moves.set(id, controller);
    this.rendererWork.set(controller, { check: () => {
      if (!retainedSource() || generation !== next.generation || renderer !== next.renderer) throw new Error("Movement was superseded.");
    } });
    const stop = () => { this.rendererWork.delete(controller); };
    try {
      if (await renderer.present(moved, controller.signal) !== "accepted") throw new Error("Movement was refused.");
      this.checkActivity(activity); this.requireTools();
      if (controller.signal.aborted || !retainedSource() || generation !== next.generation || renderer !== next.renderer)
        throw new Error("Movement was superseded.");
      stop(); previous.generation++;
      this.update({ tools: this.snapshot.tools.map(t => t.presentationId === id ? { ...t, workspaceId } : t) });
      if (previous.selectedId === id) { previous.selectedId = null; previous.expanded = false; }
      for (const frame of this.frames) if (frame.view.presentationId === id) frame.view = { ...frame.view, workspaceId };
      this.focusPresentation(id); return true;
    } catch {
      stop(); controller.abort();
      const retained = this.snapshot.tools.find(t => t.presentationId === id);
      if (!retained) { renderer.release(id); return false; }
      const state = this.workspaces.get(retained.workspaceId)!, restore = state.renderer;
      const restorationGeneration = state.generation;
      const rollback = new AbortController(); this.moves.set(id, rollback);
      this.rendererWork.set(rollback, { check: () => {
        if (rollback.signal.aborted || restorationGeneration !== state.generation || restore !== state.renderer
          || !this.snapshot.tools.some(t => t.presentationId === id && t.workspaceId === retained.workspaceId))
          throw new Error("Restoration was superseded.");
      } });
      try {
        if (!restore || await restore.present(retained, rollback.signal) !== "accepted") throw new Error("Restoration was refused.");
        if (!this.snapshot.tools.some(t => t.presentationId === id)) { restore.release(id); return false; }
        if (this.active && this.getChrome().tools.enabled && state.expanded && state.selectedId) restore.focus(state.selectedId);
        else restore.collapse();
      } catch { this.releasePresentation(id, restorationGeneration === state.generation); }
      finally { this.rendererWork.delete(rollback); }
      return false;
    } finally { stop(); this.moves.delete(id); }
  };
  getSnapshot = () => this.snapshot;
  subscribeSnapshot = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  subscribe = (listener: (event: UiEvent) => void) => {
    this.events.add(listener); listener({ type: "environment", value: this.environment }); return () => { this.events.delete(listener); };
  };
  private emit(event: UiEvent) { if (!this.disposed) for (const listener of this.events) listener(event); }
  private update(patch: Partial<UiHostSnapshot>) {
    if (this.disposed) return;
    this.snapshot = immutable({ ...this.snapshot, ...patch }); this.invalidateRendererWork();
    for (const listener of this.listeners) listener();
  }
  private invalidateRendererWork() {
    for (const [controller, work] of this.rendererWork) if (!controller.signal.aborted) {
      try { work.check(); } catch { controller.abort(); }
    }
  }
  private async runRenderer<T>(check: () => void, perform: (signal: AbortSignal) => Promise<T>, frame?: Frame): Promise<T> {
    check(); const controller = new AbortController(); this.rendererWork.set(controller, { check, frame });
    try { const result = await perform(controller.signal); check(); return result; }
    catch (error) { check(); throw error; }
    finally { this.rendererWork.delete(controller); }
  }
  private setEnvironment(connection: UiEnvironment["connection"], code?: string) {
    this.environment = { mode: "standalone", connection, ...(code ? { code } : {}) };
    this.composition.setEnvironment(this.environment);
    this.emit({ type: "environment", value: this.environment });
  }
  private async bootstrap(generation = this.activityGeneration, renewing = false): Promise<UiBootstrap> {
    this.checkActivity(generation, renewing);
    const value = await uiRequest<UiBootstrap>(this.path, "bootstrap");
    this.checkActivity(generation, renewing);
    if (value.version !== 1 || !value.app?.installationId || !value.userId) throw new UiError("unsupported_app", "Unsupported panel metadata.");
    const previous = this.snapshot.bootstrap;
    if (previous && (previous.userId !== value.userId || previous.coreOrigin !== value.coreOrigin || previous.app.installationId !== value.app.installationId)) {
      this.ledger.clear(); this.actions.clear(); this.toolQueues.clear(); this.composition.resetNavigation();
      this.resetPresentations();
      for (const frame of this.frames) {
        frame.connected = false; frame.actor = null; frame.nonce = null;
        frame.onConnection?.(false);
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
        void this.composition.refreshNavigation();
        if (!own.canHost) { this.resetPresentations(); this.activityReady = true; this.setEnvironment("unsupported", "app_permission_required"); this.update({ catalog: [], tools: [], selected: null, expanded: false }); return; }
        const catalog = await uiRequest<{ panels: UiPanel[] }>(this.path, "panels");
        this.checkActivity(generation, true);
        if (!Array.isArray(catalog.panels)) throw new UiError("ui_response_invalid", "Invalid panel catalog.");
        this.activityReady = true;
        this.update({ catalog: catalog.panels, error: null }); this.setEnvironment("connected");
        // Catalog disappearance/replacement is access loss, while temporary readiness loss retains drafts.
        const allowed = new Map(catalog.panels.map(p => [panelKey(p.panel), p]));
        this.update({ tools: this.snapshot.tools.map(tool => {
          const entry = allowed.get(panelKey(tool.target.panel));
          const invalid = !entry || !["running", "degraded", "unavailable", "starting", "stopping"].includes(entry.state);
          const surface = tool.resolved.surface && tool.panelSurface;
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

  private open(target: PanelTarget, options: PresentationOptions, source: string, frame?: Frame, sourceWorkspace?: string): Promise<PresentationResult> {
    const id = options.requestId;
    if (!this.active || !this.activityReady || this.disposed)
      return Promise.resolve({ status: "blocked", requestId: id, code: "activity_required" });
    if (!validId(id) || !validTarget(target) || options.placement !== "side" || options.reuse !== undefined && !["exact", "new"].includes(options.reuse))
      return Promise.resolve({ status: "rejected", requestId: id, code: "invalid_presentation" });
    target = { panel: { appId: target.panel.appId, installationId: target.panel.installationId, panelId: target.panel.panelId },
      ...(target.route === undefined ? {} : { route: canonicalSurfaceRoute(target.route)! }) };
    const generation = this.activityGeneration, key = `${source}:${id}`;
    const input = JSON.stringify(["open", target.panel, target.route ?? null, options.reuse ?? "exact"]);
    const existing = this.ledger.get(key);
    if (this.actions.has(key) || existing && existing.input !== input) return Promise.resolve({ status: "rejected", requestId: id, code: "request_conflict" });
    if (existing?.pending) return existing.pending;
    if (existing?.result?.status === "opened") return this.status(id, source, frame).then(result => {
      if (result.status === "opened" && result.presentationId && this.snapshot.tools.some(t => t.presentationId === result.presentationId)) {
        try { this.requireTools(frame); this.focusPresentation(result.presentationId); } catch (error) { return failure(id, error); }
      }
      return result;
    });
    if (this.pendingCount(source) >= 4) return Promise.resolve({ status: "blocked", requestId: id, code: "presentation_busy" });
    let destination: { workspaceId: string; presentationId?: string };
    try {
      this.requireTools(frame);
      destination = this.placement?.({ source: frame?.view ?? { viewId: ROOT_VIEW, workspaceId: sourceWorkspace ?? DEFAULT_WORKSPACE },
        target: structuredClone(target), presentations: structuredClone(this.snapshot.tools) }) ?? { workspaceId: frame?.view.workspaceId ?? sourceWorkspace ?? DEFAULT_WORKSPACE };
      if (!this.workspaces.get(destination.workspaceId)?.renderer) throw new UiError("presentation_unavailable", "No renderer is available for this workspace.");
      if (options.reuse === "new" && destination.presentationId) throw new UiError("invalid_presentation", "A new presentation cannot reuse an instance.");
    } catch (error) { return Promise.resolve(failure(id, error)); }
    const state = this.workspaces.get(destination.workspaceId)!, selection = ++state.generation;
    this.invalidateRendererWork();
    const entry: Ledger = { input, frame };
    const currentSource = () => !frame || frame.live && frame.connected && source === `${frame.surface.appId}:${frame.generation}:${frame.nonce}`;
    const queueKey = `${destination.workspaceId}:${panelKey(target.panel)}`, previous = this.toolQueues.get(queueKey);
    const operation = (async (): Promise<PresentationResult> => {
      if (previous) await previous;
      try {
        const own = await this.bootstrap(generation);
        const check = () => {
          this.checkActivity(generation); this.requireTools(frame);
          if (!own.canHost) throw new UiError("app_permission_required", "Allow this app to host panels.");
          if (!currentSource() || frame && frame.actor !== own.userId || this.snapshot.bootstrap?.userId !== own.userId
            || this.snapshot.bootstrap?.coreOrigin !== own.coreOrigin || this.snapshot.bootstrap?.app.installationId !== own.app.installationId)
            throw new UiError("actor_mismatch", "Reconnect using the same account.");
          if (selection !== state.generation) throw new UiError("presentation_superseded", "A newer action replaced this opening.");
        };
        check();
        const resolved = await uiRequest<UiResolvedPanel>(this.path, "panels/resolve", target); check();
        if (!resolved.available || !resolved.surface) throw new UiError(resolved.state || "destination_unavailable", "The selected panel is unavailable.");
        const matches = (tool: UiTool) => !this.moves.has(tool.presentationId) && tool.workspaceId === state.workspaceId && panelKey(tool.target.panel) === panelKey(resolved.target.panel)
          && tool.resolved.surface?.origin === resolved.surface!.origin && tool.resolved.surface?.endpoint === resolved.surface!.endpoint
          && canonicalSurfaceRoute(tool.currentRoute) === canonicalSurfaceRoute(resolved.target.route)
          && JSON.stringify(tool.resolved.surface?.framePolicy) === JSON.stringify(resolved.surface!.framePolicy);
        const preferred = destination.presentationId ? this.snapshot.tools.find(t => t.presentationId === destination.presentationId) : undefined;
        if (destination.presentationId && (!preferred || !matches(preferred))) throw new UiError("destination_changed", "The selected instance does not match this target.");
        const old = options.reuse === "new" ? undefined : preferred ?? this.snapshot.tools.filter(matches).sort((a, b) => b.focusedAt - a.focusedAt)[0];
        const insecure = window.location.protocol === "https:" && new URL(resolved.surface.origin).protocol === "http:";
        const tool: UiTool = old ?? { key: panelKey(target.panel), presentationId: createPresentationRequestId(), workspaceId: state.workspaceId,
          target: resolved.target, panelSurface: resolved.surface, resolved, readiness: insecure ? "unreported" : "loading", attention: 0, currentRoute: resolved.target.route ?? null, focusedAt: 0 };
        if (!old) this.update({ tools: [...this.snapshot.tools, tool] });
        const renderer = state.renderer!;
        try {
          const checkRenderer = () => {
            check(); if (state.renderer !== renderer) throw new UiError("presentation_superseded", "The workspace renderer changed.");
            const current = this.snapshot.tools.find(t => t.presentationId === tool.presentationId);
            if (!current?.resolved.surface || JSON.stringify(current.resolved.surface) !== JSON.stringify(tool.resolved.surface))
              throw new UiError("destination_changed", "The presentation destination changed.");
            if (!current.resolved.available) throw new UiError(current.resolved.state, "The presentation is unavailable.");
          };
          if (await this.runRenderer(checkRenderer, signal => renderer.present(tool, signal), frame) !== "accepted") throw new UiError("presentation_unavailable", "The workspace could not present this tool.");
          check();
        } catch (error) {
          if (!old) { renderer.release(tool.presentationId); this.update({ tools: this.snapshot.tools.filter(t => t.presentationId !== tool.presentationId) }); }
          throw error;
        }
        state.selectedId = tool.presentationId; state.expanded = true;
        this.update({ tools: this.snapshot.tools.map(t => t.presentationId === tool.presentationId ? { ...t, focusedAt: ++this.focusSequence } : t) });
        this.publishWorkspaces(); state.renderer?.focus(tool.presentationId);
        entry.openingSurface = resolved.surface;
        return { status: "opened", requestId: id, target: resolved.target, readiness: tool.readiness, presentationId: tool.presentationId };
      } catch (error) { return failure(id, error); }
    })();
    entry.pending = operation; this.ledger.set(key, entry); this.toolQueues.set(queueKey, operation);
    void operation.then(result => {
      entry.pending = undefined; entry.result = result;
      if (this.toolQueues.get(queueKey) === operation) this.toolQueues.delete(queueKey);
      if (!frame && this.active && generation === this.activityGeneration) this.emit({ type: "presentation", value: result });
      this.trimLedger(source);
    });
    return operation;
  }
  private pendingCount(source: string) {
    return [...this.ledger, ...this.actions].filter(([key, value]) => key.startsWith(source + ":") && value.pending).length;
  }
  private trimLedger(source: string) {
    const entries = [...this.ledger, ...this.actions].filter(([key]) => key.startsWith(source + ":"));
    for (const [key, value] of entries.slice(0, Math.max(0, entries.length - 256))) if (!value.pending) { this.ledger.delete(key); this.actions.delete(key); }
  }

  private peerResult(frame: Frame, result: PresentationResult): PresentationResult {
    if (frame.composition || result.status !== "opened") return result;
    const { presentationId: _id, ...legacy } = result; return legacy;
  }
  private action(kind: string, input: unknown, options: UiActionOptions, perform: (check: () => void) => Promise<void>, frame?: Frame): Promise<UiActionResult> {
    const id = options.requestId, source = frame ? `${frame.surface.appId}:${frame.generation}:${frame.nonce}` : "local", key = `${source}:${id}`;
    if (!validId(id)) return Promise.resolve({ status: "rejected", requestId: id, code: "invalid_presentation" });
    const payload = JSON.stringify([kind, input]), existing = this.actions.get(key);
    if (this.ledger.has(key) || existing && existing.input !== payload) return Promise.resolve({ status: "rejected", requestId: id, code: "request_conflict" });
    if (existing) return waitForPresentation(existing.pending ?? Promise.resolve(existing.result!), id, options.signal);
    if (this.pendingCount(source) >= 4) return Promise.resolve({ status: "blocked", requestId: id, code: "presentation_busy" });
    const generation = this.activityGeneration;
    const check = () => {
      this.checkActivity(generation);
      if (frame && (!frame.live || !frame.connected || frame.actor !== this.snapshot.bootstrap?.userId || source !== `${frame.surface.appId}:${frame.generation}:${frame.nonce}`))
        throw new UiError("host_unavailable", "The originating view is no longer connected.");
    };
    const entry: { input: string; pending?: Promise<UiActionResult>; result?: UiActionResult; frame?: Frame } = { input: payload, frame };
    const operation = Promise.resolve().then(async (): Promise<UiActionResult> => {
      try { check(); await perform(check); return { status: "accepted", requestId: id }; }
      catch (error) { return failure(id, error) as UiActionResult; }
    });
    entry.pending = operation; this.actions.set(key, entry);
    void operation.then(result => { entry.pending = undefined; entry.result = result; this.trimLedger(source); });
    return waitForPresentation(operation, id, options.signal);
  }
  navigate = (entryKey: string, options: UiActionOptions): Promise<UiActionResult> => this.action("navigate", entryKey, options, async check => {
    const catalog = this.getNavigation().catalog, entry = catalog?.entries.find(e => e.key === entryKey);
    if (!entry || !entry.route) throw new UiError("destination_changed", "Refresh this app's navigation.");
    if (await this.composition.navigateLocal(entry)) { check(); return; }
    const resolved = await uiRequest<UiResolvedNavigation>(this.path, "navigation/resolve", { appId: catalog!.appId, installationId: catalog!.installationId, entryKey });
    check();
    if (!resolved.available || !resolved.surface) throw new UiError(resolved.state, "This page is unavailable.");
    window.location.assign(withChromeHints(new URL(resolved.surface.route, resolved.surface.origin).href, this.getChrome()));
  });
  openToolPicker = (options: UiActionOptions): Promise<UiActionResult> => this.pickTools(options);
  private pickTools(options: UiActionOptions, frame?: Frame) {
    return this.action("picker", null, options, async check => {
      this.requireTools(frame);
      const state = this.workspaces.get(frame?.view.workspaceId ?? DEFAULT_WORKSPACE), renderer = state?.renderer;
      if (!state || !renderer) throw new UiError("presentation_unavailable", "A tool chooser is not available here.");
      const selection = ++state.generation; this.invalidateRendererWork();
      const checkRenderer = () => {
        check(); this.requireTools(frame);
        if (selection !== state.generation || renderer !== state.renderer) throw new UiError("presentation_superseded", "A newer action replaced this chooser.");
      };
      const own = await this.bootstrap(); checkRenderer();
      if (!own.canHost) throw new UiError("app_permission_required", "Allow this app to discover tools.");
      if (await this.runRenderer(checkRenderer, signal => renderer.showToolPicker(signal), frame) !== "accepted")
        throw new UiError("presentation_unavailable", "A tool chooser is not available here.");
      checkRenderer();
    }, frame);
  }
  private navigateFrame(entryKey: string, options: UiActionOptions, frame: Frame) {
    return this.action("navigate", entryKey, options, async check => {
      await this.bootstrap(); check();
      const target: UiNavigationTarget = { appId: frame.surface.appId, installationId: frame.surface.installationId, entryKey };
      const resolved = await uiRequest<UiResolvedNavigation>(this.path, "navigation/resolve", target); check();
      if (!resolved.available || !resolved.surface) throw new UiError(resolved.state, "This page is unavailable.");
      if (frame.view.navigate) {
        const navigation = frame.view.navigate(resolved.surface);
        if (navigation) await navigation;
        check();
        frame.surface = { ...resolved.surface, panelId: frame.surface.panelId };
      } else {
        this.forgetFrameRequests(frame); frame.onConnection?.(false);
        frame.surface = { ...resolved.surface, panelId: frame.surface.panelId };
        frame.connected = false; frame.actor = null; frame.nonce = null; frame.generation = createPresentationRequestId();
        frame.element.src = withChromeHints(new URL(resolved.surface.route, resolved.surface.origin).href, frame.chrome);
      }
      if (frame.view.presentationId) this.update({ tools: this.snapshot.tools.map(tool => tool.presentationId === frame.view.presentationId
        ? { ...tool, resolved: { ...tool.resolved, surface: resolved.surface }, navigationRoot: resolved.surface!.route,
          currentRoute: resolved.surface!.route, readiness: "loading" } : tool) });
    }, frame);
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
        const tool = this.snapshot.tools.find(t => t.presentationId === result.presentationId);
        // Navigation changes the live document, not the destination accepted by this request.
        if ((tool && !tool.resolved.surface) || JSON.stringify(entry?.openingSurface) !== JSON.stringify(current.surface))
          return { status: "blocked", requestId: id, code: "destination_changed" };
        return { ...result, readiness: tool && tool.currentRoute === result.target.route ? tool.readiness : result.readiness };
      }
      return result ?? { status: "unknown", requestId: id, code: "presentation_unknown" };
    } catch (error) { return failure(id, error); }
  }
  selectPanel = async (ref: PanelRef, workspaceId = DEFAULT_WORKSPACE): Promise<PresentationResult> => {
    const opened = this.snapshot.tools.filter(t => t.workspaceId === workspaceId && t.key === panelKey(ref)).sort((a, b) => b.focusedAt - a.focusedAt)[0];
    if (opened?.resolved.surface) {
      const requestId = createPresentationRequestId();
      try {
        this.requireTools();
        const state = this.workspaces.get(workspaceId)!;
        const selection = ++state.generation;
        this.invalidateRendererWork();
        const generation = this.activityGeneration, own = await this.bootstrap();
        if (!own.canHost) throw new UiError("app_permission_required", "Allow this app to host tools.");
        const resolved = await uiRequest<UiResolvedPanel>(this.path, "panels/resolve", opened.target);
        this.checkActivity(generation);
        this.requireTools();
        if (selection !== state.generation) throw new UiError("presentation_superseded", "A newer action replaced this opening.");
        if (!resolved.available || !resolved.surface) throw new UiError(resolved.state, "The tool is unavailable.");
        const surface = opened.panelSurface;
        if (surface.appId !== resolved.surface.appId || surface.installationId !== resolved.surface.installationId
          || surface.origin !== resolved.surface.origin || surface.endpoint !== resolved.surface.endpoint
          || JSON.stringify(surface.framePolicy) !== JSON.stringify(resolved.surface.framePolicy)) {
          this.update({ tools: this.snapshot.tools.map(t => t.presentationId === opened.presentationId
            ? { ...t, resolved: { ...t.resolved, available: false, surface: null, state: "destination_changed" } } : t) });
          throw new UiError("destination_changed", "The tool destination changed. Open its current version again.");
        }
        if (this.focusPresentation(opened.presentationId)) return { status: "opened", requestId, target: resolved.target, readiness: opened.readiness, presentationId: opened.presentationId };
      } catch (error) { return failure(requestId, error); }
    } else if (opened) this.closePresentation(opened.presentationId);
    const requestId = createPresentationRequestId();
    return waitForPresentation(this.open({ panel: ref }, { placement: "side", requestId }, "local", undefined, workspaceId), requestId);
  };
  setExpanded = (expanded: boolean, workspaceId = DEFAULT_WORKSPACE) => {
    if (!expanded) return this.collapseWorkspace(workspaceId);
    if (!this.active || !this.activityReady || !this.getChrome().tools.enabled) return;
    const state = this.workspaces.get(workspaceId); if (state) { state.expanded = true; this.publishWorkspaces(); }
  };
  setWidth = (width: number, workspaceId = DEFAULT_WORKSPACE) => {
    const state = this.workspaces.get(workspaceId);
    if (state && Number.isFinite(width)) { state.width = Math.min(800, Math.max(280, width)); this.publishWorkspaces(); }
  };
  setAttention = (panel: PanelRef | string, attention: number) => this.update({ tools: this.snapshot.tools.map(t =>
    (typeof panel === "string" ? t.presentationId === panel : t.key === panelKey(panel)) ? { ...t, attention: Math.max(0, Math.floor(attention)) } : t) });
  reportSurfaceState = (_state: { route: string; state: "ready" | "blocked"; code?: string }) => {};

  private forgetFrameRequests(frame: Frame) {
    frame.routeReport = undefined;
    for (const [controller, work] of this.rendererWork) if (work.frame === frame) controller.abort();
    for (const [key, entry] of this.ledger) if (entry.frame === frame) this.ledger.delete(key);
    for (const [key, entry] of this.actions) if (entry.frame === frame) this.actions.delete(key);
  }
  registerFrame = (element: HTMLIFrameElement, surface: UiFrameSurface, onConnection?: (connected: boolean) => void, view?: UiViewDescriptor): (() => void) => {
    const descriptor = view ?? { viewId: createPresentationRequestId(), workspaceId: DEFAULT_WORKSPACE, chrome: { navigation: "hide", tools: { launcher: "hide" } } };
    if (descriptor.viewId === ROOT_VIEW || [...this.frames].some(f => f.view.viewId === descriptor.viewId)) throw new Error("A view ID must be unique.");
    if (!this.workspaces.has(descriptor.workspaceId)) throw new Error("Register the workspace before its views.");
    const frame: Frame = { element, surface, view: descriptor, chrome: structuredClone(this.viewChrome.get(descriptor.viewId) ?? descriptor.chrome ?? {}), policyRevision: 0, composition: false, onConnection, generation: createPresentationRequestId(), nonce: null, connected: false, actor: null, live: true, cleanup: () => {}, waitForReadiness: () => {} };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const forget = () => this.forgetFrameRequests(frame);
    frame.waitForReadiness = () => {
      clearTimeout(timer); timer = setTimeout(() => {
        const tool = this.snapshot.tools.find(t => frame.view.presentationId ? t.presentationId === frame.view.presentationId
          : t.target.panel.panelId === frame.surface.panelId && t.resolved.surface?.appId === frame.surface.appId && t.target.route === frame.surface.route);
        if (tool?.readiness === "loading") this.reportFrame(frame, "unreported");
      }, DISCOVERY_TIMEOUT);
    };
    const loaded = () => {
      forget();
      frame.generation = createPresentationRequestId(); frame.nonce = null; frame.connected = false; frame.actor = null;
      frame.onConnection?.(false);
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
    const tools = this.snapshot.tools.map(t => (frame.view.presentationId ? t.presentationId === frame.view.presentationId : t.resolved.surface?.appId === frame.surface.appId)
      && t.target.panel.panelId === frame.surface.panelId
      && t.resolved.surface?.installationId === frame.surface.installationId && t.resolved.surface?.endpoint === frame.surface.endpoint
      && (frame.view.presentationId !== undefined || t.target.route === frame.surface.route) ? { ...t, readiness } : t);
    this.update({ tools });
    for (const [key, entry] of this.ledger) {
      const result = entry.result;
      if (result?.status !== "opened") continue;
      const tool = tools.find(t => t.presentationId === result.presentationId && t.currentRoute === result.target.route);
      if (!tool || tool.readiness === result.readiness) continue;
      entry.result = { ...result, readiness: tool.readiness };
      if (entry.frame?.live) this.post(entry.frame, { type: "hosty:ui:result", requestId: result.requestId, result: entry.result });
      else if (key.startsWith("local:")) this.emit({ type: "presentation", value: entry.result });
    }
  }
  private reportRoute(frame: Frame, value: unknown, entryKey: unknown) {
    if (!frame.view.presentationId) return;
    const route = canonicalSurfaceRoute(value);
    if (frame.routeReport?.route === route && frame.routeReport.pending) return;
    const report: NonNullable<Frame["routeReport"]> = { route }; frame.routeReport = report;
    const tool = this.snapshot.tools.find(t => t.presentationId === frame.view.presentationId);
    const declared = this.snapshot.catalog.find(p => p.panel.appId === frame.surface.appId && p.panel.panelId === frame.surface.panelId);
    const roots = [tool?.navigationRoot, declared?.origin === frame.surface.origin && declared.endpoint === frame.surface.endpoint ? declared.route : undefined];
    const currentRoute = route && roots.some(root => root && routeWithin(route, root)) ? route : null;
    this.update({ tools: this.snapshot.tools.map(t => t.presentationId === frame.view.presentationId && t.currentRoute !== currentRoute
      ? { ...t, currentRoute, readiness: "unreported" } : t) });
    if (currentRoute || !route || typeof entryKey !== "string" || !entryKey || entryKey.length > 256) return;
    const activity = this.activityGeneration, generation = frame.generation, nonce = frame.nonce, surface = frame.surface;
    report.pending = (async () => {
      try {
        const resolved = await uiRequest<UiResolvedNavigation>(this.path, "navigation/resolve", {
          appId: surface.appId, installationId: surface.installationId, entryKey,
        });
        this.checkActivity(activity);
        if (!frame.live || !frame.connected || frame.generation !== generation || frame.nonce !== nonce || frame.routeReport !== report
          || frame.actor !== this.snapshot.bootstrap?.userId) return;
        const next = resolved.surface;
        if (!resolved.available || !next || next.appId !== surface.appId || next.installationId !== surface.installationId
          || next.origin !== surface.origin || next.endpoint !== surface.endpoint || !routeWithin(route, next.route)
          || JSON.stringify(next.framePolicy) !== JSON.stringify(surface.framePolicy)) return;
        this.update({ tools: this.snapshot.tools.map(t => t.presentationId === frame.view.presentationId
          ? { ...t, navigationRoot: next.route, currentRoute: route, readiness: "unreported" } : t) });
      } catch { /* Local navigation remains usable when its host cannot verify new metadata. */ }
    })().finally(() => { report.pending = undefined; });
  }
  private async receive(event: MessageEvent) {
    if (!this.active || !this.activityReady || this.disposed) return;
    const msg = readUiMessage(event.data); if (!msg) return;
    const frame = [...this.frames].find(f => f.live && f.element.contentWindow === event.source && f.surface.origin === event.origin);
    const own = this.snapshot.bootstrap;
    if (!frame || !own?.canHost) return;
    if (msg.type === "hosty:ui:probe" && validId(msg.childNonce) && Array.isArray(msg.versions) && msg.versions.includes(1)) {
      if (frame.nonce !== msg.childNonce) {
        this.forgetFrameRequests(frame);
        frame.connected = false; frame.actor = null; frame.onConnection?.(false);
      }
      frame.nonce = msg.childNonce; frame.composition = Array.isArray(msg.capabilities) && msg.capabilities.includes(UI_COMPOSITION_CAPABILITY);
      this.post(frame, { type: "hosty:ui:offer", capabilities: [UI_COMPOSITION_CAPABILITY] }); return;
    }
    if (msg.hostWindowId !== this.windowId || msg.generation !== frame.generation || msg.childNonce !== frame.nonce || !frame.nonce) return;
    // This is advisory state, accepted only from the mounted origin/document. It grants no authority.
    if (msg.type === "hosty:ui:auth-required") {
      frame.connected = false; frame.actor = null; frame.onConnection?.(false);
      this.reportFrame(frame, "auth-required"); return;
    }
    if (msg.type === "hosty:ui:accept") {
      const wasConnected = frame.connected;
      frame.connected = msg.coreOrigin === own.coreOrigin && msg.userId === own.userId
        && msg.appId === frame.surface.appId && msg.installationId === frame.surface.installationId;
      frame.actor = frame.connected ? own.userId : null;
      if (frame.connected) { this.reportFrame(frame, "loading"); frame.waitForReadiness(); }
      this.post(frame, { type: "hosty:ui:connected", coreOrigin: own.coreOrigin, userId: own.userId,
        appId: own.app.appId, installationId: own.app.installationId, code: frame.connected ? null : "actor_mismatch", route: frame.surface.route,
        ...(frame.composition ? { capabilities: [UI_COMPOSITION_CAPABILITY], chrome: frame.chrome, revision: ++frame.policyRevision,
          rootDisabled: !this.getChrome().tools.enabled, endpoint: frame.surface.endpoint } : {}) });
      if (frame.connected !== wasConnected) frame.onConnection?.(frame.connected);
      if (!frame.connected) this.reportFrame(frame, "auth-required");
      return;
    }
    if (!frame.connected) return;
    const source = `${frame.surface.appId}:${frame.generation}:${frame.nonce}`;
    if (frame.composition && (msg.type === "hosty:ui:picker" || msg.type === "hosty:ui:navigate") && validId(msg.requestId)) {
      const result = msg.type === "hosty:ui:picker" ? await this.pickTools({ requestId: msg.requestId }, frame)
        : typeof msg.entryKey === "string" ? await this.navigateFrame(msg.entryKey, { requestId: msg.requestId }, frame)
        : { status: "rejected", requestId: msg.requestId, code: "destination_invalid" };
      if (source === `${frame.surface.appId}:${frame.generation}:${frame.nonce}`)
        this.post(frame, { type: "hosty:ui:action-result", requestId: msg.requestId, result });
      return;
    }
    if (frame.composition && msg.type === "hosty:ui:route") {
      this.reportRoute(frame, msg.route, msg.entryKey);
      return;
    }
    if (msg.type === "hosty:ui:surface-state" && frame.routeReport?.pending) {
      const report = frame.routeReport;
      if (canonicalSurfaceRoute(msg.route) !== report.route) return;
      await report.pending;
      if (!this.active || this.disposed || !frame.live || !frame.connected || frame.routeReport !== report
        || source !== `${frame.surface.appId}:${frame.generation}:${frame.nonce}`) return;
    }
    if (msg.type === "hosty:ui:open" && validId(msg.requestId)) {
      const result = await this.open(msg.target as PanelTarget, { placement: msg.placement as "side", requestId: msg.requestId, reuse: frame.composition ? msg.reuse as PresentationOptions["reuse"] : undefined }, source, frame);
      if (source === `${frame.surface.appId}:${frame.generation}:${frame.nonce}`)
        this.post(frame, { type: "hosty:ui:result", requestId: msg.requestId, result: this.peerResult(frame, result) });
    } else if (msg.type === "hosty:ui:status" && validId(msg.requestId)) {
      const result = await this.status(msg.requestId, source, frame);
      if (source === `${frame.surface.appId}:${frame.generation}:${frame.nonce}`)
        this.post(frame, { type: "hosty:ui:result", requestId: msg.requestId, result: this.peerResult(frame, result) });
    } else if (msg.type === "hosty:ui:surface-state" && canonicalSurfaceRoute(msg.route) !== null
      && canonicalSurfaceRoute(msg.route) === canonicalSurfaceRoute(frame.view.presentationId
        ? this.snapshot.tools.find(t => t.presentationId === frame.view.presentationId)?.currentRoute : frame.surface.route)) {
      if (msg.state === "ready") this.reportFrame(frame, "ready");
      else if (msg.state === "auth-required" || msg.state === "blocked") this.reportFrame(frame, "auth-required");
    } else if (msg.type === "hosty:ui:dismiss") {
      const selected = this.snapshot.tools.find(t => t.presentationId === this.workspaces.get(frame.view.workspaceId)?.selectedId);
      if (selected && (frame.view.presentationId ? selected.presentationId === frame.view.presentationId
        : selected.resolved.surface?.appId === frame.surface.appId && selected.target.panel.panelId === frame.surface.panelId && selected.target.route === frame.surface.route))
        window.dispatchEvent(new CustomEvent("hosty:ui:drawer-dismiss", { detail: frame.view.workspaceId }));
    }
  }
  dispose = () => {
    if (this.disposed) return;
    this.resetPresentations();
    this.disposed = true; this.composition.dispose(); this.actions.clear(); for (const frame of this.frames) frame.cleanup();
    window.removeEventListener("message", this.onMessage); window.removeEventListener("focus", this.onFocus);
    this.listeners.clear(); this.events.clear(); this.ledger.clear(); this.viewChrome.clear();
    if (documentHost === this) documentHost = null;
  };
}
