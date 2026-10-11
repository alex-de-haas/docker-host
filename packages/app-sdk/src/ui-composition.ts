import { UI_COMPOSITION_CAPABILITY, UiError, isSurfaceRoute, type UiChromeOverrides, type UiChromeSnapshot,
  type UiChromeSource, type UiEnvironment, type UiNavigationCatalog, type UiNavigationEntry,
  type UiNavigationSnapshot, type UiRouterAdapter } from "./ui-types";
import { canonicalSurfaceRoute, uiRequest } from "./ui-transport";

export const CHROME_HINT_ATTRIBUTE = "data-hosty-chrome-hints";
const navigationAttribute = "data-hosty-navigation";
const fields = ["hosty_navigation", "hosty_tools", "hosty_tool_launcher", "hosty_launch"] as const;
export function parseChromeHints(search: string): UiChromeOverrides & { legacy?: "show" | "hide" } {
  const params = new URLSearchParams(search);
  const one = (key: string) => params.getAll(key).length === 1 ? params.get(key) : null;
  const navigation = one(fields[0]), enabled = one(fields[1]), launcher = one(fields[2]), launch = one(fields[3]);
  return { ...(navigation === "show" || navigation === "hide" ? { navigation } : {}),
    tools: { ...(enabled === "enabled" || enabled === "disabled" ? { enabled: enabled === "enabled" } : {}),
      ...(launcher === "show" || launcher === "hide" ? { launcher } : {}) },
    ...(launch === "embedded" || launch === "native" ? { legacy: "hide" } : launch === "standalone" ? { legacy: "show" } : {}) };
}
export function validChromeOverrides(value: unknown): value is UiChromeOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as UiChromeOverrides;
  if (Object.keys(v).some(k => !["navigation", "tools"].includes(k))) return false;
  if (v.navigation !== undefined && v.navigation !== "show" && v.navigation !== "hide") return false;
  if (v.tools === undefined) return true;
  return !!v.tools && typeof v.tools === "object" && !Array.isArray(v.tools)
    && Object.keys(v.tools).every(k => k === "enabled" || k === "launcher")
    && (v.tools.enabled === undefined || typeof v.tools.enabled === "boolean")
    && (v.tools.launcher === undefined || ["show", "hide"].includes(v.tools.launcher));
}
export function resolveChrome(defaults: UiChromeOverrides, hints: ReturnType<typeof parseChromeHints>, host: UiChromeOverrides = {}) {
  function leaf<T>(values: [T | undefined, UiChromeSource][], fallback: T): [T, UiChromeSource] {
    return values.find(([value]) => value !== undefined) as [T, UiChromeSource] | undefined ?? [fallback, "default"];
  }
  const [navigation, n] = leaf([[host.navigation, "host"], [hints.navigation, "url"], [defaults.navigation, "app"], [hints.legacy, "legacy"]], "show" as const);
  const [enabled, e] = leaf([[host.tools?.enabled, "host"], [hints.tools?.enabled, "url"], [defaults.tools?.enabled, "app"]], true);
  const [launcher, l] = leaf([[host.tools?.launcher, "host"], [hints.tools?.launcher, "url"], [defaults.tools?.launcher, "app"]], "show" as const);
  return { navigation, enabled, launcher, sources: { navigation: n, enabled: e, launcher: l } };
}
export const INITIAL_CHROME: UiChromeSnapshot = Object.freeze({ navigation: "show", tools: Object.freeze({ enabled: true, launcher: "show", owner: "unavailable" }),
  revision: 0, hostRevision: -1, rootDisabled: false, stale: false, connection: "connecting", capabilities: Object.freeze([]),
  sources: Object.freeze({ navigation: "default", enabled: "default", launcher: "default" }) });
export const INITIAL_NAVIGATION: UiNavigationSnapshot = Object.freeze({ status: "loading", catalog: null, entries: Object.freeze([]), activeKey: null });

/** Presentation hints are captured only for this document, never from inherited session storage. */
export function captureChromeHints(): string {
  if (typeof document === "undefined") return "";
  const root = document.documentElement;
  const captured = root.getAttribute(CHROME_HINT_ATTRIBUTE);
  if (captured !== null) return captured;
  const params = new URLSearchParams(window.location.search), hints = new URLSearchParams();
  for (const key of fields) for (const value of params.getAll(key)) hints.append(key, value);
  root.setAttribute(CHROME_HINT_ATTRIBUTE, hints.toString());
  return hints.toString();
}
export function withChromeHints(href: string, chrome: UiChromeOverrides): string {
  const url = new URL(href, typeof location === "undefined" ? "https://surface.invalid" : location.href);
  for (const key of fields.slice(0, 3)) url.searchParams.delete(key);
  if (chrome.navigation !== undefined) url.searchParams.set(fields[0], chrome.navigation);
  if (chrome.tools?.enabled !== undefined) url.searchParams.set(fields[1], chrome.tools.enabled ? "enabled" : "disabled");
  if (chrome.tools?.launcher !== undefined) url.searchParams.set(fields[2], chrome.tools.launcher);
  return url.href;
}

export { chromeBootstrapScript } from "./index";

export function activeNavigationKey(entries: readonly UiNavigationEntry[], endpoint: string | undefined, route: string): string | null {
  const canonical = canonicalSurfaceRoute(route);
  if (!canonical || !endpoint) return null;
  const current = new URL(canonical, "https://surface.invalid");
  const candidates = entries.flatMap((entry, index) => {
    if (entry.endpoint !== endpoint || !entry.route) return [];
    const normalized = canonicalSurfaceRoute(entry.route);
    if (!normalized) return [];
    const declared = new URL(normalized, current.origin), path = declared.pathname.replace(/\/$/, "") || "/";
    if (declared.search && declared.search !== current.search || declared.hash && declared.hash !== current.hash) return [];
    if (current.pathname !== declared.pathname && (path === "/" || !current.pathname.startsWith(path + "/"))) return [];
    return [{ key: entry.key, rank: normalized === canonical ? Infinity : path.length, index }];
  });
  return candidates.sort((a, b) => b.rank - a.rank || a.index - b.index)[0]?.key ?? null;
}

/** Shared observable state for local and embedded clients; it owns no frame or identity authority. */
export class UiCompositionModel {
  private chrome = INITIAL_CHROME;
  private navigation = INITIAL_NAVIGATION;
  private readonly chromeListeners = new Set<() => void>();
  private readonly navigationListeners = new Set<() => void>();
  private readonly hints = parseChromeHints(captureChromeHints());
  private overrides: UiChromeOverrides = {};
  private hostRevision = -1;
  private hostGeneration = "";
  private rootDisabled = false;
  private capabilities: readonly string[] = [];
  private environment: UiEnvironment;
  private router?: UiRouterAdapter;
  private stopRouter?: () => void;
  private endpoint?: string;
  private epoch = 0;
  private disposed = false;
  private refreshing: Promise<void> | null = null;
  constructor(private readonly path: string, mode: UiEnvironment["mode"], private defaults: UiChromeOverrides = {}) {
    this.environment = { mode, connection: "connecting" };
    if (mode === "standalone") this.capabilities = [UI_COMPOSITION_CAPABILITY];
    this.publishChrome();
  }
  getChrome = () => this.chrome;
  subscribeChrome = (listener: () => void) => { this.chromeListeners.add(listener); return () => { this.chromeListeners.delete(listener); }; };
  getNavigation = () => this.navigation;
  subscribeNavigation = (listener: () => void) => { this.navigationListeners.add(listener); return () => { this.navigationListeners.delete(listener); }; };
  configure(defaults: UiChromeOverrides) {
    if (!validChromeOverrides(defaults)) throw new Error("Invalid chrome defaults.");
    this.defaults = structuredClone(defaults); this.publishChrome();
  }
  setEnvironment(environment: UiEnvironment) { this.environment = environment; this.publishChrome(); }
  setHostPolicy(generation: string, revision: number, policy: UiChromeOverrides, rootDisabled: boolean, endpoint?: string) {
    if (!validChromeOverrides(policy) || !Number.isSafeInteger(revision) || revision < 0) return;
    if (generation === this.hostGeneration && revision <= this.hostRevision) return;
    this.hostGeneration = generation; this.hostRevision = revision; this.overrides = structuredClone(policy);
    this.rootDisabled = rootDisabled; this.endpoint = endpoint; this.capabilities = [UI_COMPOSITION_CAPABILITY];
    this.publishChrome(); this.updateRoute();
  }
  setLegacyHost() {
    this.capabilities = []; this.overrides = {}; this.hostRevision = -1; this.hostGeneration = ""; this.rootDisabled = false; this.publishChrome();
  }
  private publishChrome() {
    const { navigation, enabled, launcher, sources } = resolveChrome(this.defaults, this.hints, this.overrides);
    const connected = this.environment.connection === "connected";
    this.chrome = Object.freeze({ navigation, tools: Object.freeze({ enabled: enabled && !this.rootDisabled, launcher,
      owner: this.environment.mode === "standalone" ? "local" : connected ? "host" : "unavailable" }),
      revision: this.chrome.revision + 1, hostRevision: this.hostRevision, rootDisabled: this.rootDisabled,
      stale: this.hostRevision >= 0 && !connected, connection: this.environment.connection,
      capabilities: Object.freeze([...this.capabilities]), sources: Object.freeze({ ...sources, ...(this.rootDisabled ? { enabled: "host" as const } : {}) }) });
    if (typeof document !== "undefined") document.documentElement.setAttribute(navigationAttribute, navigation);
    for (const listener of this.chromeListeners) listener();
  }
  attachRouter(router?: UiRouterAdapter) {
    this.stopRouter?.(); this.router = router;
    if (router) this.stopRouter = router.subscribe(() => this.updateRoute());
    else if (typeof window !== "undefined") {
      const changed = () => this.updateRoute();
      window.addEventListener("popstate", changed); window.addEventListener("hashchange", changed);
      this.stopRouter = () => { window.removeEventListener("popstate", changed); window.removeEventListener("hashchange", changed); };
    }
    this.updateRoute();
  }
  private updateNavigation(patch: Partial<UiNavigationSnapshot>) {
    this.navigation = Object.freeze({ ...this.navigation, ...patch });
    for (const listener of this.navigationListeners) listener();
  }
  currentRoute = () => this.router?.getRoute() ?? `${window.location.pathname}${window.location.search}${window.location.hash}`;
  currentEndpoint = () => {
    const endpoints = new Set(this.navigation.entries.filter(e => e.origin === window.location.origin && e.endpoint).map(e => e.endpoint!));
    return this.router?.endpoint ?? this.endpoint ?? (endpoints.size === 1 ? [...endpoints][0] : undefined);
  };
  isLocalEntry(entry: UiNavigationEntry) { return entry.origin === window.location.origin && entry.endpoint === this.currentEndpoint(); }
  updateRoute = () => {
    const origins = new Set(this.navigation.entries.filter(e => e.origin === window.location.origin && e.endpoint).map(e => e.endpoint!));
    const endpoint = this.router?.endpoint ?? this.endpoint ?? (origins.size === 1 ? [...origins][0] : undefined);
    const route = this.router?.getRoute() ?? `${window.location.pathname}${window.location.search}${window.location.hash}`;
    this.updateNavigation({ activeKey: activeNavigationKey(this.navigation.entries, endpoint, route) });
  };
  refreshNavigation = (): Promise<void> => {
    if (this.refreshing) return this.refreshing;
    const epoch = this.epoch;
    const operation = (async () => {
      try {
        const catalog = await uiRequest<UiNavigationCatalog>(this.path, "navigation");
        if (this.disposed || epoch !== this.epoch) return;
        if (!catalog.installationId || !Array.isArray(catalog.entries) || catalog.entries.some(e => e.route !== null && !isSurfaceRoute(e.route)))
          throw new UiError("ui_response_invalid", "Invalid navigation metadata.");
        const entries = Object.freeze(catalog.entries.map(e => Object.freeze({ ...e })));
        this.updateNavigation({ status: "ready", catalog: Object.freeze({ ...catalog, entries }), entries, code: undefined });
        this.updateRoute();
      } catch (error) {
        if (!this.disposed && epoch === this.epoch) this.updateNavigation({ status: "unavailable", code: error instanceof UiError ? error.code : "ui_unavailable" });
      }
    })().finally(() => { if (this.refreshing === operation) this.refreshing = null; });
    this.refreshing = operation; return operation;
  };
  resetNavigation() { this.epoch++; this.refreshing = null; this.updateNavigation({ ...INITIAL_NAVIGATION }); }
  async navigateLocal(entry: UiNavigationEntry): Promise<boolean> {
    if (!entry.route || !isSurfaceRoute(entry.route) || !this.isLocalEntry(entry)) return false;
    if (this.router) await this.router.navigate(entry.route);
    else window.location.assign(withChromeHints(new URL(entry.route, window.location.origin).href, this.chrome));
    this.updateRoute(); return true;
  }
  dispose() { this.disposed = true; this.epoch++; this.stopRouter?.(); this.chromeListeners.clear(); this.navigationListeners.clear(); }
}
