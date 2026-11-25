import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { AttemptSupervisors } from "./attempt-supervisor.js";
import type { ProviderStore } from "./store.js";

it("recovers a transient startup scan and schedules healthy attempts beside an unavailable scope", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "provider-scan-"));
  const entry = path.join(root, "attempt.mjs");
  const invalid = randomUUID(), healthy = randomUUID();
  const runs = Object.fromEntries([invalid, healthy].map(id => [id, {
    snapshot: { ref: { id }, stopConfirmed: false }, controls: {}, input: {},
  }]));
  const recordsDue = vi.fn().mockRejectedValueOnce(new Error("busy")).mockResolvedValue([{ runs }]);
  const driver = new AttemptSupervisors({ recordsDue } as unknown as ProviderStore, root, entry);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await writeFile(entry, `import { writeFileSync } from "node:fs";
writeFileSync(new URL("./" + process.argv[3], import.meta.url), "started");`);
    await mkdir(path.join(driver.directory, invalid + ".scope"), { recursive: true });
    await driver.initialize();
    await driver.start("session", invalid);
    await expect.poll(() => readFile(path.join(root, healthy), "utf8").catch(() => ""), { timeout: 6_000 }).toBe("started");
    await rm(path.join(driver.directory, invalid + ".scope"), { recursive: true });
    await expect.poll(() => readFile(path.join(root, invalid), "utf8").catch(() => ""), { timeout: 6_000 }).toBe("started");
    expect(warn.mock.calls).toHaveLength(2);
  } finally {
    await driver.close();
    warn.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
