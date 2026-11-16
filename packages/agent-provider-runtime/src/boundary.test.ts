import { expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
async function sources(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["test-support", "node_modules", "dist"].includes(entry.name)) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sources(filename));
    else if (/\.(?:ts|mjs)$/.test(entry.name) && !entry.name.includes(".test.")) files.push(filename);
  }
  return files;
}

it("keeps concrete engines and application imports out of shared production infrastructure", async () => {
  const files = [...await sources(path.join(packageRoot, "src")), ...await sources(path.join(packageRoot, "scripts"))];
  for (const filename of files) {
    const source = await readFile(filename, "utf8"), label = path.relative(packageRoot, filename);
    expect(source, label).not.toMatch(/\b(?:claude|codex|ollama)\b/i);
    const imports = [...source.matchAll(/(?:from\s*|import\s*\()\s*["']([^"']+)["']/g)].map(match => match[1]!);
    for (const specifier of imports) {
      if (specifier.startsWith(".")) {
        const relative = path.relative(packageRoot, path.resolve(path.dirname(filename), specifier));
        if (relative.startsWith("..")) expect(specifier, label).toBe("../../../scripts/npm-workspace.mjs");
      } else expect(specifier, label).toMatch(/^(?:node:|@hosty-sdk\/app(?:\/|$)|@modelcontextprotocol\/sdk(?:\/|$)|esbuild$)/);
    }
  }
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  expect(Object.keys(manifest.dependencies).sort()).toEqual(["@hosty-sdk/app", "@modelcontextprotocol/sdk"]);
  expect(manifest.peerDependencies).toBeUndefined();
});
