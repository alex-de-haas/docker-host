import { describe, expect, it } from "vitest";
import { CatalogService, deriveSourceName } from "@/lib/catalog-service";
import type { CatalogDocumentFetcher } from "@/lib/fetcher";

const sourceUrl = "https://catalog.example/store/catalog.json";

function createService(documents: Record<string, string | null>, calls: Array<{ source: string; refresh: boolean }> = []) {
  const fetcher: CatalogDocumentFetcher = {
    fetch: async (source, options) => {
      calls.push({ source, refresh: options?.refresh === true });
      return documents[source] ?? null;
    },
  };
  return new CatalogService(sourceUrl, fetcher, () => undefined);
}

function catalog(...apps: Record<string, unknown>[]): string {
  return JSON.stringify({
    schemaVersion: "marketplace.0.2",
    source: { name: "Example Catalog", description: "Curated apps" },
    apps,
  });
}

function app(id: string, extras: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, name: id, ...extras };
}

function feeds(appId: string, entries: Record<string, unknown>[]): string {
  return JSON.stringify({ schemaVersion: "app-feeds.0.1", appId, feeds: entries });
}

describe("CatalogService", () => {
  it("reports an unconfigured source without throwing", async () => {
    const service = new CatalogService(null, { fetch: async () => null }, () => undefined);

    const response = await service.getApps();

    expect(response.apps).toEqual([]);
    expect(response.diagnostic).toMatchObject({ status: "not-configured", code: "catalog_source_not_configured" });
  });

  it("normalizes and sorts catalog cards without installed-state projections", async () => {
    const service = createService({
      [sourceUrl]: catalog(
        app("com.example.zeta", { display: { summary: "Zeta summary", icon: "assets/zeta.svg" } }),
        app("com.example.alpha", { category: "Tools", tags: ["dev", "dev", "  "], publisher: { name: "Example" } }),
      ),
    });

    const response = await service.getApps();

    expect(response.apps.map(entry => entry.id)).toEqual(["com.example.alpha", "com.example.zeta"]);
    expect(response.apps[0]).not.toHaveProperty("installed");
    expect(response.apps[0].tags).toEqual(["dev"]);
    expect(response.apps[1].icon).toBe("https://catalog.example/store/assets/zeta.svg");
    expect(response.source).toEqual({ url: sourceUrl, name: "Example Catalog", description: "Curated apps" });
    expect(response.diagnostic.status).toBe("ready");
  });

  it("keeps the first duplicate app id case-insensitively", async () => {
    const service = createService({
      [sourceUrl]: catalog(app("com.example.app", { name: "First" }), app("COM.EXAMPLE.APP", { name: "Second" })),
    });

    const response = await service.getApps();

    expect(response.apps).toHaveLength(1);
    expect(response.apps[0].name).toBe("First");
  });

  it.each([
    ["{not json", "catalog_schema_unsupported"],
    [JSON.stringify({ schemaVersion: "marketplace.0.1", apps: [] }), "catalog_schema_unsupported"],
  ])("reports invalid catalog input", async (document, code) => {
    const response = await createService({ [sourceUrl]: document }).getApps();

    expect(response.apps).toEqual([]);
    expect(response.diagnostic).toMatchObject({ status: "invalid", code });
  });

  it("reports an unavailable catalog", async () => {
    const response = await createService({}).getApps();

    expect(response.diagnostic).toMatchObject({ status: "unavailable", code: "catalog_source_unavailable" });
  });

  it("loads detail, description, and a repository-owned feed document", async () => {
    const feedsUrl = "https://apps.example/notes/feeds.json";
    const descriptionUrl = "https://catalog.example/store/notes/store.md";
    const service = createService({
      [sourceUrl]: catalog(app("com.example.notes", {
        name: "Notes",
        feedsUrl,
        signerIdentity: "example-signing-key",
        display: {
          summary: "Take notes",
          screenshots: ["images/one.png"],
          descriptionUrl: "notes/store.md",
        },
      })),
      [feedsUrl]: feeds("com.example.notes", [
        { id: "stable", manifestRef: "https://apps.example/notes/manifest.json" },
      ]),
      [descriptionUrl]: "# Notes\n\nA focused note app.",
    });

    const detail = await service.getApp("com.example.notes");

    expect(detail).toMatchObject({
      id: "com.example.notes",
      feedsUrl,
      signerIdentity: "example-signing-key",
      descriptionUrl,
      description: "# Notes\n\nA focused note app.",
      feedDiagnostic: { status: "ready" },
      descriptionDiagnostic: { status: "ready" },
    });
    expect(detail?.screenshots).toEqual(["https://catalog.example/store/images/one.png"]);
    expect(detail?.feeds).toEqual([
      { id: "stable", manifestRef: "https://apps.example/notes/manifest.json", default: true },
    ]);
  });

  it("does not resolve an app feed to a manifest or call Core", async () => {
    const feedsUrl = "https://apps.example/tool/feeds.json";
    const calls: Array<{ source: string; refresh: boolean }> = [];
    const service = createService({
      [sourceUrl]: catalog(app("com.example.tool", { feedsUrl })),
      [feedsUrl]: feeds("com.example.tool", [
        { id: "main", manifestRef: "https://apps.example/tool/manifest.json", default: true },
      ]),
    }, calls);

    const detail = await service.getApp("com.example.tool");

    expect(detail?.feeds[0].manifestRef).toBe("https://apps.example/tool/manifest.json");
    expect(calls.map(call => call.source)).toEqual([sourceUrl, feedsUrl]);
  });

  it.each([
    [feeds("com.example.other", [{ id: "main", manifestRef: "https://apps.example/manifest.json" }]), "match"],
    [feeds("com.example.app", [{ id: "", manifestRef: "https://apps.example/manifest.json" }]), "non-empty"],
    [feeds("com.example.app", [{ id: "x".repeat(129), manifestRef: "https://apps.example/manifest.json" }]), "128"],
    [feeds("com.example.app", [
      { id: "main", manifestRef: "https://apps.example/main.json" },
      { id: "main", manifestRef: "https://apps.example/next.json" },
    ]), "duplicated"],
    [feeds("com.example.app", [
      { id: "main", manifestRef: "https://apps.example/main.json", default: true },
      { id: "next", manifestRef: "https://apps.example/next.json", default: true },
    ]), "At most one"],
    [feeds("com.example.app", [{ id: "main", manifestRef: "file:///tmp/manifest.json" }]), "HTTP(S)"],
  ])("surfaces feed validation diagnostics: %s", async (feedDocument, message) => {
    const feedsUrl = "https://apps.example/feeds.json";
    const detail = await createService({
      [sourceUrl]: catalog(app("com.example.app", { feedsUrl })),
      [feedsUrl]: feedDocument,
    }).getApp("com.example.app");

    expect(detail?.feeds).toEqual([]);
    expect(detail?.feedDiagnostic.status).toBe("invalid");
    expect(detail?.feedDiagnostic.message).toContain(message);
  });

  it("preserves several valid feeds without inventing a default", async () => {
    const feedsUrl = "https://apps.example/feeds.json";
    const detail = await createService({
      [sourceUrl]: catalog(app("com.example.app", { feedsUrl })),
      [feedsUrl]: feeds("com.example.app", [
        { id: "main", manifestRef: "https://apps.example/main.json" },
        { id: "preview channel", manifestRef: "https://apps.example/preview.json" },
      ]),
    }).getApp("com.example.app");

    expect(detail?.feeds.map(feed => feed.default)).toEqual([false, false]);
  });

  it("passes refresh through to catalog, feed, and description fetches", async () => {
    const calls: Array<{ source: string; refresh: boolean }> = [];
    const feedsUrl = "https://apps.example/feeds.json";
    const descriptionUrl = "https://catalog.example/store/store.md";
    const service = createService({
      [sourceUrl]: catalog(app("com.example.app", { feedsUrl, display: { descriptionUrl } })),
      [feedsUrl]: feeds("com.example.app", [{ id: "main", manifestRef: "https://apps.example/main.json" }]),
      [descriptionUrl]: "Description",
    }, calls);

    await service.getApp("com.example.app", { refresh: true });

    expect(calls).toEqual([
      { source: sourceUrl, refresh: true },
      { source: feedsUrl, refresh: true },
      { source: descriptionUrl, refresh: true },
    ]);
  });

  it("returns null for blank and unknown app ids", async () => {
    const service = createService({ [sourceUrl]: catalog(app("com.example.known")) });

    await expect(service.getApp(" ")).resolves.toBeNull();
    await expect(service.getApp("com.example.unknown")).resolves.toBeNull();
  });
});

describe("deriveSourceName", () => {
  it("derives a readable hostname", () => {
    expect(deriveSourceName("https://raw.githubusercontent.com/org/catalog/main/catalog.json"))
      .toBe("raw.githubusercontent.com");
  });

  it("reports a configured but invalid source", () => {
    expect(deriveSourceName("not a URL")).toBe("Configured catalog");
  });
});
