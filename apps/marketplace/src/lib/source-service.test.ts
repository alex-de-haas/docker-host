import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MarketplaceError } from "@/lib/errors";
import type { MarketplaceOptions } from "@/lib/options";
import { CatalogSourceService } from "@/lib/source-service";
import { BOOTSTRAP_FILE_NAME, CatalogSourceStore, STATE_FILE_NAME } from "@/lib/source-store";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "hosty-marketplace-source-tests-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function createOptions(seedSources: string[]): MarketplaceOptions {
  return { dataDirectory: root, seedSources, serviceToken: "token" };
}

function createService(seedSources: string[]): CatalogSourceService {
  const options = createOptions(seedSources);
  return new CatalogSourceService(new CatalogSourceStore(options), options);
}

async function expectMarketplaceError(action: Promise<unknown>, code: string): Promise<void> {
  try {
    await action;
  } catch (error) {
    expect(error).toBeInstanceOf(MarketplaceError);
    expect((error as MarketplaceError).code).toBe(code);
    return;
  }

  expect.unreachable(`expected MarketplaceError '${code}'`);
}

describe("CatalogSourceService", () => {
  it("reports the env seed as unmanaged", async () => {
    const response = await createService(["https://official.example/catalog.json"]).list();

    expect(response.sources).toEqual([{ url: "https://official.example/catalog.json", name: "official.example" }]);
    expect(response.managed).toBe(false);
  });

  it("uses the bootstrap handoff as a seed while no state exists", async () => {
    await fs.writeFile(
      path.join(root, BOOTSTRAP_FILE_NAME),
      '{"schemaVersion":1,"sources":[{"url":"https://imported.example/catalog.json"}]}',
    );

    const response = await createService(["https://env.example/catalog.json"]).list();

    expect(response.sources.map(source => source.url)).toEqual(["https://imported.example/catalog.json"]);
    // The handoff is a seed: reading it never marks the list managed.
    expect(response.managed).toBe(false);
  });

  it("prefers stored state over the bootstrap handoff", async () => {
    await fs.writeFile(
      path.join(root, BOOTSTRAP_FILE_NAME),
      '{"schemaVersion":1,"sources":[{"url":"https://imported.example/catalog.json"}]}',
    );
    const options = createOptions([]);
    await new CatalogSourceStore(options).write({
      schemaVersion: 1,
      sources: [{ url: "https://stored.example/catalog.json" }],
    });

    const response = await createService([]).list();

    expect(response.sources.map(source => source.url)).toEqual(["https://stored.example/catalog.json"]);
    expect(response.managed).toBe(true);
  });

  it("materializes the seed on first add and appends", async () => {
    const service = createService(["https://official.example/catalog.json"]);

    const response = await service.add("https://tap.example/catalog.json");

    expect(response.sources.map(source => source.url)).toEqual([
      "https://official.example/catalog.json",
      "https://tap.example/catalog.json",
    ]);
    expect(response.managed).toBe(true);
    await expect(fs.stat(path.join(root, STATE_FILE_NAME))).resolves.toBeTruthy();
  });

  it("rejects duplicates, normalizing host casing and default ports", async () => {
    const service = createService(["https://official.example/catalog.json"]);

    await expectMarketplaceError(service.add("https://OFFICIAL.example:443/catalog.json"), "catalog_source_exists");
  });

  it.each(["", "   ", "ftp://example.com/catalog.json", "relative/catalog.json", "https://user:secret@example.com/catalog.json"])(
    "rejects invalid source %j",
    async url => {
      await expectMarketplaceError(createService([]).add(url), "catalog_source_invalid");
    },
  );

  it("allows absolute local paths", async () => {
    const service = createService([]);

    const response = await service.add("/srv/catalogs/catalog.json");

    expect(response.sources.map(source => source.url)).toEqual(["/srv/catalogs/catalog.json"]);
  });

  it("throws not_found when removing an unconfigured source", async () => {
    await expectMarketplaceError(
      createService(["https://official.example/catalog.json"]).remove("https://absent.example/catalog.json"),
      "catalog_source_not_found",
    );
  });

  it("materializes an empty managed list when the env default is removed", async () => {
    const service = createService(["https://official.example/catalog.json"]);

    const response = await service.remove("https://official.example/catalog.json");

    expect(response.sources).toEqual([]);
    expect(response.managed).toBe(true);

    // The deliberate clear persists: the env seed no longer applies.
    const reread = await service.list();
    expect(reread.sources).toEqual([]);
    expect(reread.managed).toBe(true);
  });

  it("degrades a corrupt state file to the seed", async () => {
    await fs.writeFile(path.join(root, STATE_FILE_NAME), "{ not json");

    const response = await createService(["https://env.example/catalog.json"]).list();

    expect(response.sources.map(source => source.url)).toEqual(["https://env.example/catalog.json"]);
    expect(response.managed).toBe(false);
  });

  it("rejects an import path escaping the data directory", async () => {
    const options = createOptions([]);
    await new CatalogSourceStore(options).write({
      schemaVersion: 1,
      sources: [{ url: "/host/original/catalog.json", importPath: path.join("..", "escape.json") }],
    });

    const sources = await createService([]).getEffectiveSources();

    // The escaping import path is ignored; the fetch falls back to the operator-facing identity,
    // which resolves nothing inside the container instead of reading an arbitrary path.
    expect(sources).toEqual([{ url: "/host/original/catalog.json", fetchLocation: "/host/original/catalog.json" }]);
  });

  it("rejects an import path whose symlink escapes the data directory", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "hosty-marketplace-outside-"));
    try {
      await fs.writeFile(path.join(outside, "secret.json"), "{}");
      await fs.symlink(path.join(outside, "secret.json"), path.join(root, "sneaky.json"));

      const options = createOptions([]);
      await new CatalogSourceStore(options).write({
        schemaVersion: 1,
        sources: [{ url: "/host/original/catalog.json", importPath: "sneaky.json" }],
      });

      const sources = await createService([]).getEffectiveSources();

      // The symlink resolves outside the data root, so the fetch falls back to the operator-facing
      // identity instead of following the planted link.
      expect(sources).toEqual([{ url: "/host/original/catalog.json", fetchLocation: "/host/original/catalog.json" }]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("serializes concurrent mutations so neither add is lost", async () => {
    const service = createService([]);

    await Promise.all([service.add("https://one.example/catalog.json"), service.add("https://two.example/catalog.json")]);

    const response = await service.list();
    expect(response.sources.map(source => source.url).toSorted()).toEqual([
      "https://one.example/catalog.json",
      "https://two.example/catalog.json",
    ]);
  });

  it("round-trips import paths through the store", async () => {
    const options = createOptions([]);
    const store = new CatalogSourceStore(options);
    await store.write({
      schemaVersion: 1,
      sources: [{ url: "/host/catalog.json", importPath: "imports/a1/catalog.json" }],
    });

    const state = await store.read();

    expect(state?.sources).toEqual([{ url: "/host/catalog.json", importPath: "imports/a1/catalog.json" }]);

    // The persisted document uses camelCase wire naming.
    const raw = JSON.parse(await fs.readFile(path.join(root, STATE_FILE_NAME), "utf8")) as Record<string, unknown>;
    expect(raw).toHaveProperty("schemaVersion", 1);
  });
});
