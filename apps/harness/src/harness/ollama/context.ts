import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { OllamaExecutor } from "./executor.js";
export class OllamaContext {
  private instructions = new Map<string, string>();
  private skillsRoot: string | undefined;
  private skills = new Map<string, string>();
  constructor(
    private readonly executor: OllamaExecutor,
    private readonly home?: string,
    private readonly cwd = process.cwd(),
  ) {}
  async initialize(signal: AbortSignal): Promise<void> {
    this.instructions.clear();
    this.skills.clear();
    await this.forPath("AGENTS.md", signal);
    if (!this.home) return;
    this.skillsRoot = await realpath(
      path.join(this.home, ".agents", "skills"),
    ).catch(() => undefined);
    if (!this.skillsRoot) return;
    for (const entry of (
      await readdir(this.skillsRoot, { withFileTypes: true })
    ).slice(0, 100)) {
      if (!entry.isDirectory()) continue;
      try {
        const text = await this.readSkill(entry.name, "SKILL.md");
        const description =
          /^description:\s*(.+)$/m.exec(text)?.[1] ?? "Selected skill";
        this.skills.set(entry.name, description.slice(0, 500));
      } catch {
        continue;
      }
    }
  }
  async forPath(file: string, signal: AbortSignal): Promise<boolean> {
    if (path.isAbsolute(file)) file = path.relative(this.cwd, file);
    const dir = path.dirname(file);
    let changed = false;
    if (path.isAbsolute(file) || dir.split(/[\\/]/).includes(".."))
      return false;
    const parts = dir === "." ? [] : dir.split(/[\\/]/);
    for (let i = 0; i <= parts.length; i++) {
      const name = path.join(...parts.slice(0, i), "AGENTS.md");
      if (this.instructions.has(name)) continue;
      const result = await this.executor.execute(
        "read_file",
        { path: name, length: 64000 },
        signal,
      );
      if (result.ok && typeof result.result?.content === "string") {
        if (result.result.truncated)
          throw new Error(
            "Repository instructions exceed their file limit; no tools ran.",
          );
        changed = true;
        if (
          [...this.instructions.values()].join("").length +
            result.result.content.length >
          64000
        )
          throw new Error(
            "Repository instructions exceed their context limit.",
          );
        this.instructions.set(name, result.result.content);
      }
    }
    return changed;
  }
  async readSkill(name: string, file = "SKILL.md"): Promise<string> {
    if (
      !this.skillsRoot ||
      !name ||
      name.includes("/") ||
      name.includes("\\") ||
      name === "." ||
      name === ".."
    )
      throw new Error("Select a skill from the supplied index.");
    const root = await realpath(path.join(this.skillsRoot, name)),
      target = await realpath(path.resolve(root, file));
    if (
      path.dirname(root) !== this.skillsRoot ||
      !target.startsWith(root + path.sep)
    )
      throw new Error("Skill path leaves the selected package.");
    const info = await stat(target);
    if (!info.isFile() || info.size > 32000)
      throw new Error("Skill file is too large.");
    return readFile(target, "utf8");
  }
  text(): string {
    return (
      [...this.instructions]
        .map(([name, text]) => `Repository instructions (${name}):\n${text}`)
        .join("\n\n") +
      "\nSelected skills (use read_skill for their instructions):\n" +
      [...this.skills].map(([name, d]) => name + ": " + d).join("\n")
    );
  }
}
