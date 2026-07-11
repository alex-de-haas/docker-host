import { describe, expect, it } from "vitest";
import {
  isSameMarkdownOrigin,
  safeMarkdownBase,
  transformMarkdownUrl,
} from "@/lib/markdown-urls";

describe("Marketplace markdown URL policy", () => {
  it("resolves relative references against the description document folder", () => {
    const base = safeMarkdownBase("https://catalog.example/apps/notes/store.md");

    expect(base?.href).toBe("https://catalog.example/apps/notes/");
    expect(transformMarkdownUrl("images/screen.png", base)).toBe("https://catalog.example/apps/notes/images/screen.png");
    expect(transformMarkdownUrl("../support", base)).toBe("https://catalog.example/apps/support");
    expect(transformMarkdownUrl("#usage", base)).toBe("#usage");
  });

  it.each(["javascript:alert(1)", "data:text/html,unsafe", "file:///tmp/secret", "https://user:secret@example.test/file"])(
    "drops unsafe markdown reference %s",
    value => {
      expect(transformMarkdownUrl(value, safeMarkdownBase("https://catalog.example/store.md"))).toBe("");
    },
  );

  it("rejects an unsafe or invalid description base", () => {
    expect(safeMarkdownBase("file:///tmp/store.md")).toBeNull();
    expect(safeMarkdownBase("not a URL")).toBeNull();
    expect(safeMarkdownBase("https://user:secret@catalog.example/store.md")).toBeNull();
  });

  it("distinguishes same-origin images from third-party images", () => {
    const base = safeMarkdownBase("https://catalog.example/apps/store.md")!;

    expect(isSameMarkdownOrigin("https://catalog.example/apps/image.png", base)).toBe(true);
    expect(isSameMarkdownOrigin("https://cdn.example/image.png", base)).toBe(false);
    expect(isSameMarkdownOrigin("invalid", base)).toBe(false);
  });
});
