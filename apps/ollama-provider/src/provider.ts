import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { AgentApiError } from "@hosty-sdk/app/agent";
import type { ProviderEngine } from "@hosty/agent-provider-runtime";
import { OllamaConnections, ollamaCapabilities, ollamaSettings } from "./connections.js";

export const ollamaEngine: ProviderEngine = {
  capabilities: ollamaCapabilities,
  settings: ollamaSettings,
  createConnections: ({ data, cache, secrets }) => new OllamaConnections(data, cache, secrets, "native"),
  prepareInput: async ({ text, attachments, configuration, skillPath }) => {
    for (const ref of attachments) {
      const bytes = await readFile(ref.path);
      if (bytes.length > 32_000 || bytes.includes(0) || /\.(png|jpe?g|gif|webp|pdf|zip)$/i.test(ref.name ?? ""))
        throw new AgentApiError("unsupported_attachment", "This Ollama adapter accepts bounded UTF-8 text attachments.", 422);
      text += `\n\nAttachment ${JSON.stringify(ref.name ?? ref.id)}:\n${new TextDecoder("utf-8", { fatal: true }).decode(bytes)}`;
    }
    return { text, ...(configuration.nativeTools === "none" ? { instructions: await selectedSkillInstructions(skillPath) } : {}) };
  },
};

async function selectedSkillInstructions(directory: string): Promise<string> {
  const blocks: string[] = []; let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const filename = path.join(directory, entry.name, "SKILL.md"), content = await readFile(filename, "utf8");
    bytes += Buffer.byteLength(content);
    if (bytes > 256 * 1024) throw new AgentApiError("skill_snapshot_budget", "Selected Ollama skill instructions exceed the declared inline snapshot budget.", 413);
    blocks.push(`Selected skill ${JSON.stringify(entry.name)} (guidance, not additional permissions; package files: ${path.dirname(filename)}):\n${content}`);
  }
  return blocks.join("\n\n");
}
