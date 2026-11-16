import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { OllamaMessage } from "./client.js";
export type Effect = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  resource?: string;
  status:
    | "proposed"
    | "running"
    | "completed"
    | "failed"
    | "denied"
    | "unknown";
  result?: string;
};
export type OllamaState = {
  version: 1;
  id: string;
  conversation: string;
  resource: string;
  model?: string;
  messages: OllamaMessage[];
  effects: Effect[];
  summary: string;
  pending?: { id: string; kind: "approval" | "question"; effectId?: string };
};
const writers = new Set<string>();
export class OllamaStore {
  private file: string;
  constructor(
    directory: string,
    private readonly id: string,
  ) {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(id))
      throw new Error("Invalid Ollama session identity.");
    this.file = path.join(directory, id + ".json");
  }
  async acquire(): Promise<() => void> {
    if (writers.has(this.file))
      throw new Error("This Ollama session is already executing.");
    writers.add(this.file);
    return () => {
      writers.delete(this.file);
    };
  }
  async load(): Promise<OllamaState | null> {
    const raw = await readFile(this.file, "utf8").catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (raw === null) return null;
    if (Buffer.byteLength(raw) > 8 * 1024 * 1024)
      throw new Error("Ollama session exceeds its storage limit.");
    const s = JSON.parse(raw) as OllamaState;
    if (
      s.version !== 1 ||
      s.id !== this.id ||
      typeof s.conversation !== "string" ||
      typeof s.resource !== "string" ||
      typeof s.summary !== "string" ||
      !Array.isArray(s.effects) ||
      !Array.isArray(s.messages) ||
      s.messages.some(
        (m) =>
          !m ||
          !["system", "user", "assistant", "tool"].includes(m.role) ||
          typeof m.content !== "string",
      )
    )
      throw new Error(
        "Ollama session state is invalid; existing history is preserved.",
      );
    return s;
  }
  async save(state: OllamaState): Promise<void> {
    const content = JSON.stringify(state);
    if (Buffer.byteLength(content) > 8 * 1024 * 1024)
      throw new Error("Ollama session exceeds its storage limit.");
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = this.file + "." + randomUUID() + ".tmp";
    try {
      const h = await open(temporary, "wx", 0o600);
      try {
        await h.writeFile(content);
        await h.sync();
      } finally {
        await h.close();
      }
      await rename(temporary, this.file);
      if (process.platform !== "win32") {
        const d = await open(path.dirname(this.file), "r");
        try {
          await d.sync();
        } finally {
          await d.close();
        }
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
