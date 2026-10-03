// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "../src/proxy";

afterEach(() => vi.unstubAllEnvs());
describe("canonical local browser navigation", () => {
  const origin = "http://ahosty-dshellz.hosty.localhost:7171";
  function request(path = "/dashboard", method = "GET", navigate = true, host = "localhost:7171") {
    return new NextRequest(`http://${host}${path}`, { method, headers: {
      host, ...(navigate ? { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" } : {}),
    } });
  }
  it.each(["localhost:7171", "127.0.0.1:7171", "[::1]:7171"])("canonicalizes %s before sign-in", (host) => {
    vi.stubEnv("HOSTY_PUBLIC_ORIGIN_WEB", origin);
    const response = proxy(request("/dashboard", "GET", true, host));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`${origin}/dashboard`);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("keeps credentials, callbacks, API requests and canonical navigation on their requested origin", () => {
    vi.stubEnv("HOSTY_PUBLIC_ORIGIN_WEB", origin);
    for (const value of [request("/dashboard", "POST"), request("/dashboard?code=one-time"),
      request("/dashboard", "GET", false), request("/dashboard", "GET", true, new URL(origin).host)]) {
      expect(proxy(value).headers.has("location")).toBe(false);
    }
  });
  it("uses an explicit public origin and tolerates standalone operation without injected configuration", () => {
    vi.stubEnv("HOSTY_PUBLIC_ORIGIN_WEB", "https://shell.example.test");
    expect(proxy(request()).headers.get("location")).toBe("https://shell.example.test/dashboard");
    vi.stubEnv("HOSTY_PUBLIC_ORIGIN_WEB", "");
    expect(proxy(request()).headers.has("location")).toBe(false);
  });
});
