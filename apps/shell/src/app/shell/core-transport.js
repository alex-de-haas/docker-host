import { appFetch } from "@hosty-sdk/app/browser-auth";
/** Core API reads use Shell's app session. Browser navigation keeps the public Core origin. */
export function coreApiPath(url) {
  const parsed = new URL(url, "http://core.invalid");
  if (!parsed.pathname.startsWith("/api/") || parsed.hash || parsed.username || parsed.password) {
    throw new Error("Expected a Core API URL.");
  }
  return `/api/core${parsed.pathname}${parsed.search}`;
}

/** @param {string} url @param {RequestInit} [init] */
export function fetchCore(url, init) {
  return appFetch(coreApiPath(url), { ...init, credentials: "same-origin" });
}
