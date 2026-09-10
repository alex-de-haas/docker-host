import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AppIdentityBridgeState } from "@hosty-sdk/app/react";

const bridge = vi.hoisted(() => ({ state: { kind: "recovering" } as AppIdentityBridgeState }));
vi.mock("@hosty-sdk/app/react", () => ({
  AppIdentityBridge: ({ renderState }: { renderState: (state: AppIdentityBridgeState) => unknown }) => renderState(bridge.state),
}));
import { MarketplaceSession } from "./marketplace-session";

describe("Marketplace session gate", () => {
  it("renders only session loading before identity is established", () => {
    bridge.state = { kind: "recovering" };
    const html = renderToStaticMarkup(createElement(MarketplaceSession));
    expect(html).toContain("Connecting to your Hosty session");
    expect(html).toContain('role="status"');
    expect(html).not.toContain("Loading catalog");
    expect(html).not.toContain("No source configured");
    expect(html).not.toContain('role="alert"');
  });

  it.each(["denied", "unavailable", "misconfigured"] as const)("shows one terminal %s error without catalog placeholders", (kind) => {
    bridge.state = { kind };
    const html = renderToStaticMarkup(createElement(MarketplaceSession));
    expect(html.match(/role="alert"/g)).toHaveLength(1);
    expect(html).not.toContain("Loading catalog");
    expect(html).not.toContain("No source configured");
    expect(html).not.toContain("Catalog source");
  });

  it("offers the Hosty sign-in route after recovery ends", () => {
    bridge.state = { kind: "signin", openUrl: "https://host.example/open", embedded: true };
    const html = renderToStaticMarkup(createElement(MarketplaceSession));
    expect(html).toContain('href="https://host.example/open"');
    expect(html).toContain("Sign in via Hosty");
    expect(html).not.toContain("Loading catalog");
  });

  it("starts the storefront with only catalog loading after the session is active", () => {
    bridge.state = { kind: "active" };
    const html = renderToStaticMarkup(createElement(MarketplaceSession));
    expect(html).toContain("Loading catalog");
    expect(html).not.toContain("Connecting to your Hosty session");
    expect(html).not.toContain("No source configured");
    expect(html).not.toContain("Marketplace is not ready");
  });
});
