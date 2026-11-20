import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ProviderError } from "@hosty-sdk/app/providers";
import { durableMkdir, durableWriteFile } from "./persistence.js";
import { speechKinds, type SpeechChoice, type SpeechKind } from "../shared/speech-selection.js";

export type StoredSpeech = { revision: number; choices: Partial<Record<SpeechKind, SpeechChoice | null>> };
export function accountScope(userId: string) {
  return createHash("sha256").update(userId).digest("hex");
}
export function isSpeechChoice(value: unknown): value is SpeechChoice {
  if (!value || typeof value !== "object") return false;
  const choice = value as SpeechChoice;
  return [choice.appId, choice.installationId, choice.key, choice.displayName].every(s => typeof s === "string" && !!s)
    && (choice.implementationId == null || typeof choice.implementationId === "string" && !!choice.implementationId);
}

export class SpeechPreferences {
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private readonly dataDir: string) {}
  private file(userId: string) {
    return path.join(this.dataDir, "preferences", "speech", accountScope(userId) + ".json");
  }
  async read(userId: string): Promise<StoredSpeech> {
    try {
      const value = JSON.parse(await readFile(this.file(userId), "utf8")) as StoredSpeech;
      if (!Number.isSafeInteger(value.revision) || value.revision < 0 || !value.choices || typeof value.choices !== "object"
        || speechKinds.some(kind => kind in value.choices && value.choices[kind] !== null && !isSpeechChoice(value.choices[kind])))
        throw new Error("The stored speech preferences could not be read.");
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { revision: 0, choices: {} };
      throw error;
    }
  }
  save(userId: string, revision: unknown, kind: SpeechKind, choice: SpeechChoice | null): Promise<StoredSpeech> {
    const result = this.writes.then(async () => {
      const current = await this.read(userId);
      if (revision !== current.revision)
        throw new ProviderError("preference_changed", "Your speech settings changed. Reload before saving.", 409);
      const next = { revision: current.revision + 1, choices: { ...current.choices, [kind]: choice } };
      const file = this.file(userId);
      await durableMkdir(path.dirname(file));
      await durableWriteFile(file, JSON.stringify(next));
      return next;
    });
    this.writes = result.catch(() => {});
    return result;
  }
}
