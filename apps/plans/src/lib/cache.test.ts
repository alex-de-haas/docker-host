import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { blobSha, DocumentCache } from "./cache";
const directories: string[] = [];
async function create(maxBytes?: number) { const directory = await mkdtemp(path.join(tmpdir(), "hosty-plans-cache-")); directories.push(directory); return { directory, cache: new DocumentCache(directory, maxBytes) }; }
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
describe("blob cache", () => {
  it("stores syntax and content under the actual Git blob SHA and preserves UTF-8 BOM bytes", async () => {
    const { directory, cache } = await create();
    const content = "\uFEFF# Text\nHello";
    const sha = blobSha(content);
    await cache.write(sha, "docs/root.md", content);
    expect((await cache.read(sha, "docs/root.md"))?.content).toBe(content);
    expect(await readdir(directory)).toEqual([`${sha}.json`]);
    const raw = JSON.parse(await readFile(path.join(directory, `${sha}.json`), "utf8"));
    expect(raw.documents["docs/root.md"].title).toBe("docs/root.md");
    expect(raw).not.toHaveProperty("credential");
  });
  it("refuses mismatched SHA and corrupted bytes and cannot escape its directory", async () => {
    const { directory, cache } = await create();
    await expect(cache.write(blobSha("one"), "docs/root.md", "two")).rejects.toThrow("does not match");
    const sha = blobSha("one");
    await writeFile(path.join(directory, `${sha}.json`), JSON.stringify({ version: 1, content: "two", documents: {} }));
    expect(await cache.read(sha, "docs/root.md")).toBeNull();
    await expect(cache.read("../../secret", "docs/root.md")).rejects.toThrow("Invalid blob SHA");
  });
  it("enforces one disk bound under concurrent writes and supports SHA256 repositories", async () => {
    const { directory, cache } = await create(2300);
    await Promise.all(["a", "b", "c", "d"].map(letter => { const content = `# Title\n${letter.repeat(500)}`; return cache.write(blobSha(content), "docs/root.md", content); }));
    const files = await readdir(directory);
    const size = (await Promise.all(files.map(file => stat(path.join(directory, file))))).reduce((sum, item) => sum + item.size, 0);
    expect(size).toBeLessThanOrEqual(2300);
    expect(files.length).toBeLessThan(4);
    const content = "# sha256";
    await cache.write(blobSha(content, 64), "docs/root.md", content);
    expect((await cache.read(blobSha(content, 64), "docs/root.md"))?.content).toBe(content);
  });
  it("bounds validated parse reuse and separates current reference facts", async () => {
    const { cache } = await create(3000);
    const references = [{ path: "apps/test", exists: true, isDirectory: true }];
    const content = "---\nstatus: Ready\ncreated: 2026-10-06\nupdated: 2026-10-07\nsummary: Example.\ncomponents: [apps/test]\n---\n# Example\n## Deliverables\n- [ ] D1. " + "x".repeat(400);
    const first = blobSha(content);
    cache.validate(first, "docs/features/test/plan.md", content, references);
    expect(cache.readValidated(first, "docs/features/test/plan.md", references)?.progress).toEqual({ done: 0, total: 1 });
    expect(cache.readValidated(first, "docs/features/test/plan.md", [{ path: "apps/test", exists: false, isDirectory: false }])).toBeNull();
    const next = content.replace("# Example", "# Another example");
    cache.validate(blobSha(next), "docs/features/test/plan.md", next, references);
    expect(cache.readValidated(first, "docs/features/test/plan.md", references)).toBeNull();
    expect(cache.readValidated(blobSha(next), "docs/features/test/plan.md", references)?.title).toBe("Another example");
  });
});
