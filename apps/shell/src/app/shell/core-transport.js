import { appFetch } from "@hosty-sdk/app/browser-auth";
/** Core API reads use Shell's app session. Browser navigation keeps the public Core origin. */
export function coreApiPath(url) {
  const parsed = new URL(url, "http://core.invalid");
  if (!parsed.pathname.startsWith("/api/") || parsed.hash || parsed.username || parsed.password) throw new Error("Expected a Core API URL.");
  return `/api/core${parsed.pathname}${parsed.search}`;
}
const reviews = new Map();
/** @param {string} url @param {RequestInit} [init] */
export async function fetchCore(url, init) {
  const key = JSON.stringify([url, init?.method ?? "GET", init?.body ?? ""]);
  const headers = new Headers(init?.headers);
  const saved = reviews.get(key);
  if (saved) headers.set("X-Hosty-Settings-Change", saved);
  const send = () => appFetch(coreApiPath(url), { ...init, headers, credentials: "same-origin" });
  let response = await send();
  if (response.status !== 428 || typeof window === "undefined") {
    if (response.ok || response.status === 409 || response.status === 403) reviews.delete(key);
    return response;
  }
  const review = await response.clone().json();
  if (typeof review.id !== "string" || !/^[a-f0-9]{32}$/.test(review.id) || typeof review.approvalUrl !== "string") return response;
  const approval = new URL(review.approvalUrl);
  if (!["http:", "https:"].includes(approval.protocol) || approval.pathname !== `/settings/confirm/${review.id}` || approval.username || approval.password)
    throw new Error("Core returned an invalid confirmation address.");
  reviews.set(key, review.id);
  let approved = false;
  try {
    await new Promise((complete, reject) => window.dispatchEvent(new CustomEvent("hosty:settings-review", { detail: {
      url: approval.href, statusUrl: `${approval.origin}/api/settings/changes/${review.id}`, headers,
      complete, fail: reject,
    } })));
    approved = true;
    headers.set("X-Hosty-Settings-Change", review.id);
    response = await send();
    if (response.ok || response.status === 409 || response.status === 403) reviews.delete(key);
    return response;
  } catch (cause) { if (!approved) reviews.delete(key); throw cause; }
}
