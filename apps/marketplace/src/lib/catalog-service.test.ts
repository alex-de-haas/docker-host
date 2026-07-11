import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CatalogService, deriveSourceName } from "@/lib/catalog-service";
import type { CatalogDocumentFetcher } from "@/lib/fetcher";
import type { MarketplaceOptions } from "@/lib/options";
import { CatalogSourceService } from "@/lib/source-service";
import { CatalogSourceStore } from "@/lib/source-store";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "hosty-marketplace-tests-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function createOptions(seedSources: string[]): MarketplaceOptions {
  return { dataDirectory: root, seedSources, serviceToken: "token" };
}

function createService(seedSources: string[], documents: Record<string, string>): CatalogService {
  const options = createOptions(seedSources);
  const fetcher: CatalogDocumentFetcher = {
    fetch: async source => documents[source] ?? null,
  };
  return new CatalogService(new CatalogSourceService(new CatalogSourceStore(options), options), fetcher, () => undefined);
}

function index(...entries: string[]): string {
  return `{"schemaVersion":"marketplace.0.1","apps":[${entries.join(",")}]}`;
}

function entry(id: string, name?: string, feeds = "[]"): string {
  return `{"id":"${id}","name":"${name ?? id}","feeds":${feeds}}`;
}

describe("CatalogService", () => {
  it("returns an empty catalog without sources", async () => {
    const service = createService([], {});

    const response = await service.getApps();

    expect(response.apps).toEqual([]);
  });

  it("sorts summaries by name", async () => {
    const service = createService(["https://catalog.example/catalog.json"], {
      "https://catalog.example/catalog.json": index(
        entry("com.example.zeta", "Zeta"),
        entry("com.example.alpha", "Alpha"),
      ),
    });

    const response = await service.getApps();

    expect(response.apps.map(app => app.name)).toEqual(["Alpha", "Zeta"]);
  });

  it("lets the first source win an id conflict, case-insensitively", async () => {
    const service = createService(
      ["https://first.example/catalog.json", "https://second.example/catalog.json"],
      {
        "https://first.example/catalog.json": index(entry("com.example.app", "First Copy")),
        "https://second.example/catalog.json": index(entry("COM.EXAMPLE.APP", "Second Copy")),
      },
    );

    const response = await service.getApps();

    expect(response.apps).toHaveLength(1);
    expect(response.apps[0].name).toBe("First Copy");
    expect(response.apps[0].sourceName).toBe("first.example");
  });

  it("skips unreachable, malformed, and unsupported-schema sources", async () => {
    const service = createService(
      [
        "https://unreachable.example/catalog.json",
        "https://malformed.example/catalog.json",
        "https://unsupported.example/catalog.json",
        "https://valid.example/catalog.json",
      ],
      {
        "https://malformed.example/catalog.json": "{ not json",
        "https://unsupported.example/catalog.json": '{"schemaVersion":"marketplace.9.9","apps":[{"id":"com.example.ghost"}]}',
        "https://valid.example/catalog.json": index(entry("com.example.real", "Real")),
      },
    );

    const response = await service.getApps();

    expect(response.apps.map(app => app.id)).toEqual(["com.example.real"]);
  });

  it("degrades malformed nested shapes instead of crashing", async () => {
    // A schema-valid envelope with wrong nested types: apps as an object is skipped entirely; a
    // string tags/feeds/name inside an entry normalizes away rather than throwing mid-aggregation.
    const service = createService(
      ["https://object-apps.example/catalog.json", "https://mangled-entry.example/catalog.json"],
      {
        "https://object-apps.example/catalog.json": '{"schemaVersion":"marketplace.0.1","apps":{"id":"com.example.trap"}}',
        "https://mangled-entry.example/catalog.json":
          '{"schemaVersion":"marketplace.0.1","apps":[{"id":"com.example.mangled","name":123,"tags":"not-a-list","feeds":"not-a-list","display":"not-an-object"},null]}',
      },
    );

    const response = await service.getApps();
    const detail = await service.getApp("com.example.mangled");

    expect(response.apps.map(app => app.id)).toEqual(["com.example.mangled"]);
    expect(response.apps[0].name).toBe("com.example.mangled");
    expect(response.apps[0].tags).toEqual([]);
    expect(detail?.feeds).toEqual([]);
  });

  it("returns null for unknown or blank detail ids", async () => {
    const service = createService(["https://catalog.example/catalog.json"], {
      "https://catalog.example/catalog.json": index(entry("com.example.known")),
    });

    expect(await service.getApp("com.example.unknown")).toBeNull();
    expect(await service.getApp("  ")).toBeNull();
  });

  it("normalizes a sole feed as the default", async () => {
    const service = createService(["https://catalog.example/catalog.json"], {
      "https://catalog.example/catalog.json": index(
        entry("com.example.app", undefined, '[{"id":"main","manifestRef":"https://example.invalid/manifest.json"}]'),
      ),
    });

    const detail = await service.getApp("com.example.app");

    expect(detail?.feeds).toEqual([
      { id: "main", manifestRef: "https://example.invalid/manifest.json", default: true },
    ]);
  });

  it("keeps the first of several default feeds and drops blank ones", async () => {
    const feeds = JSON.stringify([
      { id: "main", manifestRef: "https://example.invalid/main.json", default: true },
      { id: "stable", manifestRef: "https://example.invalid/stable.json", default: true },
      { id: "broken", manifestRef: "   " },
    ]);
    const service = createService(["https://catalog.example/catalog.json"], {
      "https://catalog.example/catalog.json": index(entry("com.example.app", undefined, feeds)),
    });

    const detail = await service.getApp("com.example.app");

    expect(detail?.feeds).toHaveLength(2);
    expect(detail?.feeds[0].default).toBe(true);
    expect(detail?.feeds[1].default).toBe(false);
  });

  it("fetches an imported source from app data while naming the operator-facing identity", async () => {
    await fs.mkdir(path.join(root, "imports"), { recursive: true });
    const importedPath = path.join(root, "imports", "catalog.json");
    await fs.writeFile(importedPath, index(entry("com.example.imported", "Imported")));

    const options = createOptions([]);
    const store = new CatalogSourceStore(options);
    await store.write({
      schemaVersion: 1,
      sources: [{ url: "/host/original/catalog.json", importPath: path.join("imports", "catalog.json") }],
    });

    const fetcher: CatalogDocumentFetcher = {
      fetch: async source => {
        try {
          return await fs.readFile(source, "utf8");
        } catch {
          return null;
        }
      },
    };
    const service = new CatalogService(new CatalogSourceService(store, options), fetcher, () => undefined);

    const response = await service.getApps();

    expect(response.apps.map(app => app.id)).toEqual(["com.example.imported"]);
    // The card names the operator-facing source identity, not the internal snapshot path.
    expect(response.apps[0].sourceName).toBe("catalog.json");
  });
});

describe("deriveSourceName", () => {
  it.each([
    ["https://raw.githubusercontent.com/org/hosty-catalog/main/catalog.json", "raw.githubusercontent.com"],
    ["/srv/catalogs/private/catalog.json", "catalog.json"],
  ])("derives %s -> %s", (source, expected) => {
    expect(deriveSourceName(source)).toBe(expected);
  });
});
