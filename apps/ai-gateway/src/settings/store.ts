import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

// Operator-owned assistant policy, living in the gateway's own data directory.
//
// Where this state lives is a decision, not an accident: Core stays the registry (which apps exist,
// which declare an `mcp` interface, at what URL) and the gateway owns the policy (which of them the
// assistant may reach, and what the operator prepended to the system prompt). Putting the toggles in
// Core would make the kernel hold configuration for a replaceable app.
//
// These are not Hosty app settings either. Those are flat key/value pairs rendered by a generic
// dialog, which cannot express a list that changes as the fleet changes.

export interface AssistantSettings {
  /**
   * Operator text appended to the harness's own instruction sources — never replacing them. The
   * Claude adapter runs with settingSources ["user", "project"], so the operator's own CLAUDE.md and
   * skills already flow in; displacing them would make the assistant stop behaving the way the same
   * operator's CLI does, with nothing on screen to explain it.
   */
  systemPrompt: string;
  /**
   * appId → enabled. Absent means disabled: tool names and descriptions are third-party text landing
   * in the context of a model that holds host shell, so an app appearing in the fleet must not
   * silently gain a channel into the agent. Enabling is a decision, not a side effect of installing.
   */
  mcpProviders: Record<string, boolean>;
}

const DEFAULTS: AssistantSettings = { systemPrompt: "", mcpProviders: {} };

/** Cap on the operator prompt. Generous for instructions, small enough not to crowd the context. */
export const MAX_SYSTEM_PROMPT_CHARS = 8_000;

export class SettingsStore {
  private cached: AssistantSettings | null = null;

  constructor(private readonly dataDir: string) {}

  private get file(): string {
    return path.join(this.dataDir, "settings.json");
  }

  async read(): Promise<AssistantSettings> {
    if (this.cached) {
      return this.cached;
    }

    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as Partial<AssistantSettings>;
      this.cached = {
        systemPrompt: typeof parsed.systemPrompt === "string" ? parsed.systemPrompt : "",
        mcpProviders: isBooleanRecord(parsed.mcpProviders) ? parsed.mcpProviders : {},
      };
    } catch {
      // Missing or unreadable settings must not take the assistant down — an operator with a broken
      // file still gets a working chat, just with defaults.
      this.cached = { ...DEFAULTS };
    }

    return this.cached;
  }

  async update(patch: Partial<AssistantSettings>): Promise<AssistantSettings> {
    const current = await this.read();
    const next: AssistantSettings = {
      systemPrompt: (patch.systemPrompt ?? current.systemPrompt).slice(0, MAX_SYSTEM_PROMPT_CHARS),
      mcpProviders: patch.mcpProviders ?? current.mcpProviders,
    };

    await mkdir(this.dataDir, { recursive: true });
    // Temp file plus rename: a crash mid-write must not leave a truncated settings file that the
    // next start silently reads as "everything disabled, prompt gone".
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(next, null, 2), "utf8");
    await rename(temporary, this.file);
    this.cached = next;
    return next;
  }

  /**
   * Drops toggles for apps that are no longer installed, so an uninstall-reinstall cycle cannot
   * silently resurrect a provider the operator had enabled under an earlier install.
   */
  async prune(installedAppIds: readonly string[]): Promise<AssistantSettings> {
    const current = await this.read();
    const installed = new Set(installedAppIds);
    const kept: Record<string, boolean> = {};
    for (const [appId, enabled] of Object.entries(current.mcpProviders)) {
      if (installed.has(appId)) {
        kept[appId] = enabled;
      }
    }

    if (Object.keys(kept).length === Object.keys(current.mcpProviders).length) {
      return current;
    }
    return this.update({ mcpProviders: kept });
  }
}

function isBooleanRecord(value: unknown): value is Record<string, boolean> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "boolean")
  );
}
