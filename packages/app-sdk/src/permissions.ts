import type { PermissionNoticeState } from "./permission-types.js";
export type { PermissionNoticeState } from "./permission-types.js";

export const PERMISSION_REVIEW_REQUEST = "hosty:request-permission-review";

/** No optional declaration, or declaration alone, confers authority. */
export function permissionNotice(state: PermissionNoticeState): "missing" | "unsupported" | null {
  if (state.hostRole !== "host.admin" || !state.permissions) return null;
  const p = state.permissions;
  if (p.unsupportedRequired?.length) return "unsupported";
  return p.required.some(name => !p.granted.includes(name)) ? "missing" : null;
}

export function permissionReviewUrl(corePublicOrigin: string, appId: string): string {
  const core = new URL(corePublicOrigin);
  if (!["http:", "https:"].includes(core.protocol) || core.username || core.password) throw new Error("Invalid Core origin");
  return new URL(`/install/permissions/${encodeURIComponent(appId)}`, core.origin).href;
}

/** Invoke synchronously from a user click. The embedder determines the app from its frame. */
export function requestPermissionReview(state: PermissionNoticeState, browser: Pick<Window, "parent" | "open"> = window): void {
  if (permissionNotice(state) !== "missing" || state.permissions?.reviewAvailable === false || !state.corePublicOrigin) return;
  if (browser.parent !== browser) browser.parent.postMessage({ type: PERMISSION_REVIEW_REQUEST }, "*");
  else browser.open(permissionReviewUrl(state.corePublicOrigin, state.appId), "_blank", "noopener,noreferrer");
}
