import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarketplaceSession } from "./marketplace-session";

describe("Marketplace session gate", () => {
  it("uses the real SDK loading boundary before rendering any storefront data", () => {
    const html = renderToStaticMarkup(createElement(MarketplaceSession));
    expect(html).toContain('aria-label="Connecting to Hosty"');
    expect(html).not.toContain("Loading catalog");
    expect(html).not.toContain("No source configured");
    expect(html).not.toContain("Permission notice");
  });
});
