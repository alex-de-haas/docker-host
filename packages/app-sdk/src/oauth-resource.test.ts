import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildProtectedResourceMetadata, buildWwwAuthenticate } from "./oauth-resource";

const ENV_KEYS = ["HOSTY_CORE_PUBLIC_ORIGIN", "HOSTY_PUBLIC_ORIGIN_API"] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
  process.env.HOSTY_CORE_PUBLIC_ORIGIN = "https://core.example.test";
  process.env.HOSTY_PUBLIC_ORIGIN_API = "https://notes.example.test";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

describe("protected resource metadata", () => {
  it("names this app's endpoint as the resource and Core as the authorization server", () => {
    const metadata = buildProtectedResourceMetadata();
    expect(metadata).toEqual({
      resource: "https://notes.example.test/api/mcp",
      authorization_servers: ["https://core.example.test"],
      scopes_supported: ["mcp:read"],
      bearer_methods_supported: ["header"],
    });
  });

  it("derives the challenge header's metadata URL the RFC 9728 way", () => {
    const metadata = buildProtectedResourceMetadata()!;
    expect(buildWwwAuthenticate(metadata)).toBe(
      'Bearer resource_metadata="https://notes.example.test/.well-known/oauth-protected-resource/api/mcp"',
    );
  });

  it("refuses to guess when either URL is missing", () => {
    // A wrong resource identity would have clients requesting tokens for a URL nothing serves; a
    // loopback authorization server would send a remote browser to the wrong machine. Null is the
    // honest answer to both, and the caller simply serves no metadata.
    delete process.env.HOSTY_PUBLIC_ORIGIN_API;
    expect(buildProtectedResourceMetadata()).toBeNull();

    process.env.HOSTY_PUBLIC_ORIGIN_API = "https://notes.example.test";
    delete process.env.HOSTY_CORE_PUBLIC_ORIGIN;
    expect(buildProtectedResourceMetadata()).toBeNull();

    expect(
      buildProtectedResourceMetadata({
        resourceUrl: "https://x.test/api/mcp",
        authorizationServerOrigin: "https://as.test/",
      }),
    ).toEqual({
      resource: "https://x.test/api/mcp",
      authorization_servers: ["https://as.test"],
      scopes_supported: ["mcp:read"],
      bearer_methods_supported: ["header"],
    });
  });
});
