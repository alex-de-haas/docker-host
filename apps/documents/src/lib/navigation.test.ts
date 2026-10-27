import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { catalogUrl, documentView, restoreCatalogScope } from "./navigation";

const manifest = JSON.parse(readFileSync(new URL("../../manifest.json", import.meta.url), "utf8"));
describe("manifest document navigation", () => {
  it("opens every declared section with filters and supports legacy query links", () => {
    expect(manifest.ui.navigation.map((entry: { label: string }) => entry.label)).toEqual(["Home", "Vision", "Ideas", "Features", "Plans", "Reviews", "Tooling"]);
    for (const entry of manifest.ui.navigation) {
      const expected = entry.label.toLowerCase();
      expect(documentView(entry.path, new URLSearchParams("repository=repo&q=needle"))).toBe(expected);
      expect(documentView("/", new URLSearchParams({ view: expected }))).toBe(expected);
    }
    expect(documentView("/plans", new URLSearchParams("view=ideas"))).toBe("plans");
    expect(documentView("/", new URLSearchParams("view=invalid"))).toBe("home");
  });
  it("keeps document, workspace, status and return scope on the section route", () => {
    const query = new URLSearchParams({ view: "plans", repository: "repo", document: "docs/features/a/plan.md", workspace: "work", catalogRepository: "", status: "In Progress" });
    const url = new URL(catalogUrl(query), "https://documents.example");
    expect(url.pathname).toBe("/plans");
    expect(url.searchParams.has("view")).toBe(false);
    for (const [key, value] of query) if (key !== "view") expect(url.searchParams.get(key)).toBe(value);
    expect(query.get("view")).toBe("plans");
  });
  it("retains selectors across host page launches without restoring view-specific filters", () => {
    const query = new URLSearchParams("view=vision");
    const result = restoreCatalogScope(query, JSON.stringify({ repository: "repo", app: "app", q: "old", status: "Draft", page: "3" }));
    expect(result.toString()).toBe("view=vision&repository=repo&app=app");
    expect(query.toString()).toBe("view=vision");
  });
  it("honors explicit selectors and All selections when returning through browser history", () => {
    const saved = JSON.stringify({ repository: "other", app: "other" });
    const query = new URLSearchParams("view=plans&repository=&app=&status=Ready");
    expect(restoreCatalogScope(query, saved).toString()).toBe(query.toString());
    expect(restoreCatalogScope(new URLSearchParams("repository=linked&app=linked"), saved).toString()).toBe("repository=linked&app=linked");
  });
  it("ignores unavailable and malformed stored preferences", () => {
    for (const value of [null, "{broken", "null", "[]", '{"repository":4,"app":{}}']) {
      expect(restoreCatalogScope(new URLSearchParams(), value).toString()).toBe("repository=&app=");
    }
  });
});
