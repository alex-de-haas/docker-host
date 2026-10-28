import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { AppContextError } from "./app-context.js";

export type SuggestionPreference = { enabled: boolean; revision: number };
/** Personal settings deliberately live outside shared agent profiles. */
export class SuggestionPreferences {
  constructor(private readonly dataDir: string) {}
  private file(userId: string): string {
    return path.join(this.dataDir, "preferences", "prompt-suggestions", createHash("sha256").update(userId).digest("hex") + ".json");
  }
  async get(userId: string): Promise<SuggestionPreference> {
    try {
      const value = JSON.parse(await readFile(this.file(userId), "utf8")) as SuggestionPreference;
      if (typeof value.enabled !== "boolean" || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error("Invalid suggestion preference.");
      return { enabled: value.enabled, revision: value.revision };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { enabled: true, revision: 0 };
      throw error;
    }
  }
  /** The coordinator serializes writes by authenticated user. */
  async set(userId: string, input: Record<string, unknown>): Promise<SuggestionPreference> {
    if (typeof input.enabled !== "boolean" || !Number.isSafeInteger(input.revision))
      throw new AppContextError(400, "invalid_preference", "Choose whether to show prompt suggestions.");
    const current = await this.get(userId);
    if (input.revision !== current.revision) throw new AppContextError(409, "preference_changed", "Your preference changed in another view. Reload before saving.");
    const next = { enabled: input.enabled, revision: current.revision + 1 };
    const file = this.file(userId), temporary = file + "." + randomUUID();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
    await rename(temporary, file);
    return next;
  }
}
