// @vitest-environment node
import { beforeAll, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import loadConfig from "next/dist/server/config";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
import { buildCustomRoute } from "next/dist/server/lib/router-utils/filesystem";

let matchingHeaders: (pathname: string) => Headers;
beforeAll(async () => {
  const config = await loadConfig(PHASE_PRODUCTION_BUILD, fileURLToPath(new URL("..", import.meta.url)));
  const routes = (await config.headers!()).map(route => buildCustomRoute("header", route));
  matchingHeaders = pathname => {
    const headers = new Headers();
    for (const route of routes) {
      if (route.match(pathname) !== false) {
        for (const header of route.headers) headers.set(header.key, header.value);
      }
    }
    return headers;
  };
});

it.each(["/auth/start", "/auth/start/"])("preserves the route-owned sign-in CSP at %s", pathname => {
  const headers = matchingHeaders(pathname);
  expect(headers.get("x-frame-options")).toBe("DENY");
  expect(headers.has("content-security-policy")).toBe(false);
});

it.each(["/", "/dashboard", "/workspace", "/auth/callback", "/auth/logout", "/auth/start/child",
  "/auth/start-other", "/api/auth/identity", "/_next/static/test.js"])("keeps ordinary Shell frame protection at %s", pathname => {
  const headers = matchingHeaders(pathname);
  expect(headers.get("x-frame-options")).toBe("DENY");
  expect(headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
});
