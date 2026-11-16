import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FakeHarnessAdapter } from "../harness/fake.js";
import { linkSkillDirectory, resolveSkillExport, skillAdapter } from "./skills.js";

const roots: string[] = [];
async function temp() { const root = await mkdtemp(path.join(os.tmpdir(), "hosty-skills-test-")); roots.push(root); return root; }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe.each(["codex", "claude"] as const)("%s native skill discovery", kind => {
  it("isolates concurrent selections on one connection and reads current complete packages", async () => {
    const root = await temp(), connection = path.join(root, "connection");
    await mkdir(connection); await writeFile(path.join(connection, "auth.json"), "connection-owned");
    const exports = [path.join(root, "one"), path.join(root, "two")];
    for (const [index, selected] of exports.entries()) {
      await mkdir(path.join(selected, `skill-${index}`, "references"), { recursive: true });
      await writeFile(path.join(selected, `skill-${index}`, "SKILL.md"), `skill ${index}`);
      await writeFile(path.join(selected, `skill-${index}`, "references", "guide.md"), "version one");
    }
    const delegates = [new FakeHarnessAdapter(), new FakeHarnessAdapter()];
    const adapters = await Promise.all(delegates.map((adapter, i) => skillAdapter(adapter, connection, kind, exports[i]!)));
    const runs = adapters.map((adapter, i) => adapter.start({ sessionId: `session-${i}`, cwd: root, onEvent: () => {} }));
    try {
      const homes = delegates.map(adapter => adapter.lastStart!.nativeHome!);
      expect(homes[0]).not.toBe(homes[1]);
      const discovery = (home: string) => kind === "codex" ? path.join(home, ".agents", "skills") : path.join(home, "skills");
      expect(await readdir(discovery(homes[0]!))).toEqual(["skill-0"]);
      expect(await readdir(discovery(homes[1]!))).toEqual(["skill-1"]);
      const reference = path.join(discovery(homes[0]!), "skill-0", "references", "guide.md");
      expect(await readFile(reference, "utf8")).toBe("version one");
      await writeFile(path.join(exports[0]!, "skill-0", "references", "guide.md"), "version two");
      expect(await readFile(reference, "utf8")).toBe("version two");
      await rm(path.join(exports[0]!, "skill-0"), { recursive: true });
      expect(await readdir(discovery(homes[0]!))).toEqual([]);
      expect(await readdir(discovery(homes[1]!))).toEqual(["skill-1"]);
      if (kind === "claude") expect(await realpath(path.join(homes[0]!, "projects"))).toBe(await realpath(path.join(connection, "projects")));
      await runs[0]!.stop();
      await expect(realpath(homes[0]!)).rejects.toThrow();
      expect(await readdir(discovery(homes[1]!))).toEqual(["skill-1"]);
      expect(await readFile(path.join(connection, "auth.json"), "utf8")).toBe("connection-owned");
    } finally { await Promise.all(runs.map(run => run.stop())); await Promise.all(adapters.map(adapter => adapter.dispose?.())); }
  });

  it("does not overwrite an existing native skill directory", async () => {
    const root = await temp(), selected = await temp();
    await linkSkillDirectory(root, kind, selected);
    await expect(linkSkillDirectory(root, kind, await temp())).rejects.toThrow();
  });
});

it("rejects export path traversal and redirects outside the scoped collection", async () => {
  const root = await temp(), outside = await temp(), id = "a".repeat(64);
  await expect(resolveSkillExport(root, "../other")).rejects.toThrow();
  await expect(resolveSkillExport(undefined, id)).rejects.toThrow();
  await symlink(outside, path.join(root, id), process.platform === "win32" ? "junction" : "dir");
  await expect(resolveSkillExport(root, id)).rejects.toThrow("outside");
});
