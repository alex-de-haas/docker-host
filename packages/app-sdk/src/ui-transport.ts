import { appFetch } from "./browser-auth";
import { UiError, isSurfaceRoute, type PanelTarget, type PresentationResult, type UiActionResult } from "./ui-types";

export const UI_VERSION = 1;
export const DISCOVERY_TIMEOUT = 5_000;
export const RESPONSE_TIMEOUT = 10_000;
export type UiMessage = Record<string, unknown> & { type: string; version: 1 };
export function readUiMessage(value: unknown): UiMessage | null {
  if (!value || typeof value !== "object") return null;
  try { if (new TextEncoder().encode(JSON.stringify(value)).length > 16_384) return null; } catch { return null; }
  const msg = value as Record<string, unknown>;
  return msg.version === UI_VERSION && typeof msg.type === "string" && msg.type.startsWith("hosty:ui:") ? msg as UiMessage : null;
}
export function validId(value: unknown): value is string { return typeof value === "string" && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value); }
export function canonicalSurfaceRoute(value: unknown): string | null {
  if (!isSurfaceRoute(value)) return null;
  const route = new URL(value, "https://surface.invalid");
  for (const key of ["hosty_launch", "hosty_theme", "hosty_theme_preference", "hosty_navigation", "hosty_tools", "hosty_tool_launcher"]) route.searchParams.delete(key);
  return `${route.pathname}${route.search}${route.hash}`;
}
export function validTarget(value: unknown): value is PanelTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as Partial<PanelTarget>, panel = target.panel;
  return !!panel && [panel.appId, panel.installationId, panel.panelId].every(s => typeof s === "string" && s.length > 0 && s.length <= 256)
    && (target.route === undefined || isSurfaceRoute(target.route));
}
export function uiPath(path = "/api/hosty/ui"): string {
  if (!path.startsWith("/") || path.startsWith("//") || /[?#\\]/.test(path)) throw new Error("uiPath must be a same-origin path.");
  return path.replace(/\/$/, "");
}
export async function uiRequest<T>(path: string, suffix: string, body?: unknown): Promise<T> {
  const response = await appFetch(`${path}/${suffix}`, { method: body === undefined ? "GET" : "POST", cache: "no-store", redirect: "error",
    signal: AbortSignal.timeout(RESPONSE_TIMEOUT), headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json().catch(() => null);
  if (response.status === 404) throw new UiError("unsupported_app", "This app does not support shared panels.", 404);
  if (!response.ok) throw new UiError(value?.code ?? "ui_unavailable", value?.message ?? "Unable to open the panel.", response.status);
  if (!value) throw new UiError("ui_response_invalid", "The app returned invalid panel metadata.", 502);
  return value as T;
}
export function failure(requestId: string, error: unknown): PresentationResult {
  return { status: error instanceof UiError && error.code.startsWith("unsupported") ? "unsupported" : "blocked", requestId,
    code: error instanceof UiError ? error.code : "ui_unavailable" };
}
export function waitForPresentation<T extends PresentationResult | UiActionResult>(operation: Promise<T>, requestId: string, signal?: AbortSignal): Promise<T> {
  return new Promise(resolve => {
    const finish = (value: PresentationResult | UiActionResult) => { clearTimeout(timer); signal?.removeEventListener("abort", uncertain); resolve(value as T); };
    const uncertain = () => finish({ status: "uncertain", requestId, code: "presentation_unknown" });
    const timer = setTimeout(uncertain, RESPONSE_TIMEOUT);
    if (signal?.aborted) uncertain(); else signal?.addEventListener("abort", uncertain, { once: true });
    void operation.then(finish, error => finish(failure(requestId, error)));
  });
}
