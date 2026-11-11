import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { AppContextError } from "../sessions/app-context.js";
import type { PromptTemplate, PromptTemplateDirectory, SavePromptTemplates } from "./types.js";

export const MAX_PROMPT_TEMPLATE_BYTES = 512 * 1024;
const MAX_RECEIPTS = 32;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fields = ["id", "name", "shortcut", "text"];
type Receipt = { requestId: string; hash: string; revision: number };
type StoredDirectory = PromptTemplateDirectory & { version: 1; receipts: Receipt[] };

function invalid(message = "Enter a title, a shortcut and prompt text for each template.") {
  return new AppContextError(400, "prompt_templates_invalid", message);
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function templates(input: unknown): PromptTemplate[] {
  if (!Array.isArray(input) || input.length > 100) throw invalid("Save at most 100 prompt templates.");
  const ids = new Set<string>(), shortcuts = new Set<string>();
  return input.map(value => {
    if (!object(value) || Object.keys(value).some(key => !fields.includes(key))
      || typeof value.id !== "string" || !uuid.test(value.id)
      || typeof value.name !== "string" || !value.name.trim() || value.name.length > 120 || /[\x00-\x1f\x7f]/.test(value.name)
      || typeof value.shortcut !== "string" || !/^[a-z0-9][a-z0-9_-]{0,39}$/i.test(value.shortcut)
      || typeof value.text !== "string" || !value.text.trim() || value.text.length > 16000) throw invalid();
    const id = value.id.toLowerCase(), shortcut = value.shortcut.toLowerCase();
    if (ids.has(id)) throw invalid("Each prompt template must have a unique ID.");
    if (shortcuts.has(shortcut)) throw invalid("Choose a different shortcut for each prompt template.");
    ids.add(id); shortcuts.add(shortcut);
    return { id, name: value.name.trim(), shortcut, text: value.text };
  });
}

/** Personal libraries have one writer per authenticated user and atomic durable receipts. */
export class PromptTemplateStore {
  private readonly operations = new Map<string, Promise<unknown>>();
  constructor(private readonly dataDir: string) {}
  private file(userId: string): string {
    return path.join(this.dataDir, "preferences", "prompt-templates", createHash("sha256").update(userId).digest("hex") + ".json");
  }
  private serial<T>(userId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(userId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    this.operations.set(userId, next);
    void next.finally(() => { if (this.operations.get(userId) === next) this.operations.delete(userId); }).catch(() => undefined);
    return next;
  }
  private async load(userId: string): Promise<StoredDirectory> {
    let raw: string;
    try { raw = await readFile(this.file(userId), "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, revision: 0, templates: [], receipts: [] };
      throw error;
    }
    const value: unknown = JSON.parse(raw);
    if (!object(value) || value.version !== 1 || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0
      || !Array.isArray(value.receipts) || value.receipts.length > MAX_RECEIPTS) throw new Error("Invalid stored prompt templates.");
    const revision = value.revision as number;
    const receipts = value.receipts as Receipt[];
    if (receipts.some(receipt => !object(receipt) || typeof receipt.requestId !== "string" || !uuid.test(receipt.requestId)
      || typeof receipt.hash !== "string" || !/^[a-f0-9]{64}$/.test(receipt.hash)
      || !Number.isSafeInteger(receipt.revision) || receipt.revision < 1 || receipt.revision > revision)
      || new Set(receipts.map(receipt => receipt.requestId)).size !== receipts.length) throw new Error("Invalid stored prompt template receipts.");
    let entries: PromptTemplate[];
    try { entries = templates(value.templates); }
    catch { throw new Error("Invalid stored prompt templates."); }
    this.assertSize({ revision, templates: entries });
    return { version: 1, revision, templates: entries, receipts };
  }
  private assertSize(value: PromptTemplateDirectory): void {
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_PROMPT_TEMPLATE_BYTES)
      throw invalid("The prompt template library must fit within 512 KiB.");
  }
  private snapshot(state: PromptTemplateDirectory): PromptTemplateDirectory {
    return { revision: state.revision, templates: state.templates.map(template => ({ ...template })) };
  }
  read(userId: string): Promise<PromptTemplateDirectory> {
    return this.serial(userId, async () => this.snapshot(await this.load(userId)));
  }
  save(userId: string, input: unknown): Promise<PromptTemplateDirectory> {
    if (!object(input) || Object.keys(input).some(key => !["revision", "requestId", "templates"].includes(key))
      || !Number.isSafeInteger(input.revision) || (input.revision as number) < 0
      || typeof input.requestId !== "string" || !uuid.test(input.requestId)) throw invalid("Save the displayed revision with a request UUID and your templates.");
    const entries = templates(input.templates);
    const request = input as unknown as SavePromptTemplates;
    this.assertSize({ revision: request.revision, templates: entries });
    // Fixed key order makes JSON object order irrelevant, while retaining the literal request
    // values: changed whitespace or shortcut casing is a changed request, even if normalized alike.
    const hash = createHash("sha256").update(JSON.stringify({ revision: request.revision,
      templates: request.templates.map(template => ({ id: template.id, name: template.name, shortcut: template.shortcut, text: template.text })) })).digest("hex");
    const requestId = request.requestId.toLowerCase();
    return this.serial(userId, async () => {
      const current = await this.load(userId);
      const receipt = current.receipts.find(item => item.requestId === requestId);
      if (receipt) {
        if (receipt.hash !== hash) throw new AppContextError(409, "prompt_template_request_reused", "This save request was already used with different templates. Reload before saving again.");
        return this.snapshot(current);
      }
      if (request.revision !== current.revision) throw new AppContextError(409, "prompt_templates_changed", "Your prompt templates changed in another view. Reload before saving.");
      if (current.revision === Number.MAX_SAFE_INTEGER) throw new Error("Prompt template revision limit reached.");
      const revision = current.revision + 1;
      const next: StoredDirectory = { version: 1, revision, templates: entries,
        receipts: [...current.receipts, { requestId, hash, revision }].slice(-MAX_RECEIPTS) };
      this.assertSize(next);
      const file = this.file(userId), temporary = `${file}.${randomUUID()}.tmp`;
      await mkdir(path.dirname(file), { recursive: true });
      try { await writeFile(temporary, JSON.stringify(next) + "\n", { mode: 0o600 }); await rename(temporary, file); }
      finally { await rm(temporary, { force: true }); }
      return this.snapshot(next);
    });
  }
}
