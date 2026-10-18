import { INITIAL_CHROME, INITIAL_NAVIGATION } from "./ui-composition";
import type { UiChromeSnapshot, UiNavigationSnapshot, UiActionOptions, UiNavigationOptions, UiActionResult, PanelTarget, PresentationOptions, PresentationResult, UiEnvironment, UiEvent } from "@hosty-sdk/app/ui/types";
export * from "@hosty-sdk/app/ui/types";

export interface UiClient {
  getEnvironment(): UiEnvironment;
  getChrome(): UiChromeSnapshot;
  subscribeChrome(listener: () => void): () => void;
  getNavigation(): UiNavigationSnapshot;
  subscribeNavigation(listener: () => void): () => void;
  navigate(entryKey: string, options: UiNavigationOptions): Promise<UiActionResult>;
  openToolPicker(options: UiActionOptions): Promise<UiActionResult>;
  openSurface(target: PanelTarget, options: PresentationOptions): Promise<PresentationResult>;
  getPresentation(requestId: string, options?: { signal?: AbortSignal }): Promise<PresentationResult>;
  subscribe(listener: (event: UiEvent) => void): () => void;
  reportSurfaceState(state: { route: string; state: "ready" | "blocked"; code?: string }): void;
}

let active: UiClient | null = null;
const listeners = new Set<(event: UiEvent) => void>();
const unavailable = (requestId: string): PresentationResult => ({ status: "unsupported", requestId, code: "host_unavailable" });
const chromeListeners = new Set<() => void>(), navigationListeners = new Set<() => void>();
const initial: UiEnvironment = { mode: "standalone", connection: "connecting" };

/** One document-local facade shared by domain apps; it never selects a provider or opens popups. */
export const ui: UiClient = {
  getEnvironment: () => active?.getEnvironment() ?? initial,
  getChrome: () => active?.getChrome() ?? INITIAL_CHROME,
  subscribeChrome(listener) { chromeListeners.add(listener); return () => { chromeListeners.delete(listener); }; },
  getNavigation: () => active?.getNavigation() ?? INITIAL_NAVIGATION,
  subscribeNavigation(listener) { navigationListeners.add(listener); return () => { navigationListeners.delete(listener); }; },
  navigate: (key, options) => active?.navigate(key, options) ?? Promise.resolve({ status: "unsupported", requestId: options.requestId, code: "host_unavailable" }),
  openToolPicker: options => active?.openToolPicker(options) ?? Promise.resolve({ status: "unsupported", requestId: options.requestId, code: "host_unavailable" }),
  openSurface: (target, options) => active?.openSurface(target, options) ?? Promise.resolve(unavailable(options.requestId)),
  getPresentation: (id, options) => active?.getPresentation(id, options) ?? Promise.resolve(unavailable(id)),
  subscribe(listener) { listeners.add(listener); listener({ type: "environment", value: ui.getEnvironment() }); return () => { listeners.delete(listener); }; },
  reportSurfaceState: state => active?.reportSurfaceState(state),
};

/** Internal root integration; exported from this source only, not as an ambient browser global. */
export function bindUiClient(client: UiClient): () => void {
  if (active && active !== client) throw new Error("Mount one Hosty UI root per document.");
  active = client;
  const releaseChrome = client.subscribeChrome(() => { for (const l of chromeListeners) l(); });
  const releaseNavigation = client.subscribeNavigation(() => { for (const l of navigationListeners) l(); });
  for (const l of chromeListeners) l();
  for (const l of navigationListeners) l();
  const release = client.subscribe(event => { for (const listener of listeners) listener(event); });
  return () => {
    release(); releaseChrome(); releaseNavigation();
    if (active === client) {
      active = null;
      for (const listener of chromeListeners) listener();
      for (const listener of navigationListeners) listener();
      for (const listener of listeners) listener({ type: "environment", value: initial });
    }
  };
}

export function createPresentationRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 15) | 64; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
