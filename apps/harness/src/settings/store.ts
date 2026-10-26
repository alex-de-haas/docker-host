import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { validRules, validDefaults, type ToolRule, type ProviderDefault } from "../mcp/policy.js";
import { DEFAULT_WORKFLOW_PROMPT } from "./workflow.js";
import { CORE_PROVIDER_ID } from "./providers.js";
import type { ConnectionBinding } from "../connections/registry.js";
import { isTranslationModel } from "../translation/models.js";

// Harness owns invocation preferences and reviewed instructions. Core owns MCP access.
export interface SkillAcceptance { identity: string; digest: string }
export function validSkillAcceptances(value: unknown): value is Record<string, SkillAcceptance> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length <= 1000 &&
    Object.values(value).every(v => v && typeof v === "object" && typeof v.identity === "string" && v.identity.length < 3000 &&
      typeof v.digest === "string" && /^[a-f0-9]{32}$/.test(v.digest)));
}

export interface RetentionSettings { ordinaryDays: number | null; completedWorkspaceDays: number | null }
export function validRetention(value: unknown): value is RetentionSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2 && ["ordinaryDays", "completedWorkspaceDays"].every(key =>
    record[key] === null || Number.isSafeInteger(record[key]) && Number(record[key]) >= 1 && Number(record[key]) <= 3650);
}

export interface AssistantSettings {
  /** Stable Core package IDs; contents always follow the installed library. */
  skillIds?: string[];
  workflowPrompt?: string;
  retention?: RetentionSettings;
  executionMode?: "native" | "docker";
  translationConnections?: Partial<Record<"codex" | "claude", ConnectionBinding | null>>;
  translationModels?: Partial<Record<"codex" | "claude", string | null>>;
  mcpToolRules?: Record<string, ToolRule>;
  mcpPolicyMigrated?: string[];
  mcpDefaults?: Record<string, ProviderDefault>;
  mcpSkillApprovals?: Record<string, SkillAcceptance>;
  mcpSkillsMigrated?: boolean;
  immediateHandoffs?: boolean;
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
  /**
   * appId → may this app's read-only tools run without an approval card. Absent means no.
   *
   * Per app, and off by default, because of what the flag actually delegates. The built-in tools the
   * harness auto-allows (Read, Grep, …) are read-only because the gateway *knows* what they are; an
   * app tool is read-only because the **app said so** in its `readOnlyHint`. Turning this on is the
   * operator saying "I trust this app's declarations about itself" — which is a judgement only they
   * can make, and one they will make differently for their own app than for a third-party one.
   *
   * The realistic failure it guards is not a hostile app — an installed app already runs code on the
   * host and needs no trickery — but an honest mislabelled annotation on a mutating tool, which would
   * then run unprompted. A single global switch would have been the same mistake as trusting the hint
   * outright.
   */
  mcpAutoAllow: Record<string, boolean>;
  /**
   * appId → digest of the skill text the operator has accepted from that app.
   *
   * Enabling a provider is consent to the app's prose **as it stands**; it cannot be consent to
   * whatever the publisher writes next. An update rewrites the file under the same path, and without
   * this the new instructions would reach the model on the strength of a decision made about
   * different text.
   *
   * Recorded on first delivery rather than demanded up front: enabling is the act of consent, and
   * asking twice for the same decision is what this feature already refused to do elsewhere. What is
   * withheld is a *change* after that.
   */
  mcpSkillDigests: Record<string, string>;
}

const DEFAULTS: AssistantSettings = { systemPrompt: "", mcpProviders: {}, mcpAutoAllow: {}, mcpSkillDigests: {} };

/**
 * Core is the one provider that defaults to on, with its read-only tools unprompted.
 *
 * The opt-in rule on `mcpProviders` exists because an app's tool text is third-party prose and its
 * `readOnlyHint` is the app's own word about itself. Neither holds for Core: the platform wrote both,
 * its read tools are asserted read-only by its own test suite, and an assistant whose purpose is
 * operating the host has no reason to start blind to it. Absent means on, so a settings file from
 * before the row existed gains it without being rewritten, and an operator's explicit off survives
 * every read.
 */
function withCoreDefaults(settings: AssistantSettings): AssistantSettings {
  return {
    ...settings,
    mcpProviders: { [CORE_PROVIDER_ID]: true, ...settings.mcpProviders },
    mcpAutoAllow: { [CORE_PROVIDER_ID]: true, ...settings.mcpAutoAllow },
  };
}

/** Cap on the operator prompt. Generous for instructions, small enough not to crowd the context. */
export const MAX_SYSTEM_PROMPT_CHARS = 8_000;

export class SettingsStore {
  /**
   * Serializes update, which is a read-modify-write.
   *
   * Two callers reading the same snapshot and writing back their own patch lose one of the two, and
   * the pair that loses is invisible: a digest silently absent later reads as "this app changed" and
   * withholds a skill nobody touched.
   */
  private queue: Promise<unknown> = Promise.resolve();
  private cached: AssistantSettings | null = null;

  constructor(private readonly dataDir: string, private readonly legacyRetentionDays = 30) {}

  private get file(): string {
    return path.join(this.dataDir, "settings.json");
  }

  async read(): Promise<AssistantSettings> {
    if (this.cached) {
      return this.cached;
    }

    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as Partial<AssistantSettings>;
      this.cached = withCoreDefaults({
        skillIds: Array.isArray(parsed.skillIds) && parsed.skillIds.every((id: unknown) => typeof id === "string" && /^[a-f0-9]{64}$/.test(id)) ? parsed.skillIds : undefined,
        workflowPrompt: typeof parsed.workflowPrompt === "string" ? parsed.workflowPrompt : DEFAULT_WORKFLOW_PROMPT,
        retention: validRetention(parsed.retention) ? parsed.retention : { ordinaryDays: parsed.retention === undefined ? this.legacyRetentionDays : null, completedWorkspaceDays: null },
        executionMode: parsed.executionMode === "docker" ? "docker" : "native",
        translationConnections: validTranslationConnections(parsed.translationConnections) ? parsed.translationConnections : {},
        translationModels: validTranslationModels(parsed.translationModels) ? parsed.translationModels : {},
        immediateHandoffs: parsed.immediateHandoffs === true,
        mcpDefaults: validDefaults(parsed.mcpDefaults) ? parsed.mcpDefaults : {},
        mcpSkillApprovals: validSkillAcceptances(parsed.mcpSkillApprovals) ? parsed.mcpSkillApprovals : {},
        mcpSkillsMigrated: parsed.mcpSkillsMigrated === true,
        mcpToolRules: validRules(parsed.mcpToolRules) ? parsed.mcpToolRules : {},
        mcpPolicyMigrated: Array.isArray(parsed.mcpPolicyMigrated) ? parsed.mcpPolicyMigrated.filter(v => typeof v === "string") : [],
        systemPrompt: typeof parsed.systemPrompt === "string" ? parsed.systemPrompt : "",
        mcpProviders: isBooleanRecord(parsed.mcpProviders) ? parsed.mcpProviders : {},
        mcpAutoAllow: isBooleanRecord(parsed.mcpAutoAllow) ? parsed.mcpAutoAllow : {},
        mcpSkillDigests: isStringRecord(parsed.mcpSkillDigests) ? parsed.mcpSkillDigests : {},
      });
    } catch (error) {
      // Missing or unreadable settings must not take the assistant down — an operator with a broken
      // file still gets a working chat, just with defaults.
      this.cached = withCoreDefaults({ ...DEFAULTS, workflowPrompt: DEFAULT_WORKFLOW_PROMPT,
        retention: { ordinaryDays: (error as NodeJS.ErrnoException).code === "ENOENT" ? this.legacyRetentionDays : null, completedWorkspaceDays: null } });
    }

    return this.cached;
  }

  async update(patch: Partial<AssistantSettings>): Promise<AssistantSettings> {
    // Chained rather than locked: each update waits for the one before it, so the snapshot it reads
    // is never one another writer has already replaced. A rejected predecessor must not poison the
    // chain, hence the swallow.
    const run = this.queue.then(() => this.applyUpdate(patch), () => this.applyUpdate(patch));
    this.queue = run.catch(() => undefined);
    return run;
  }

  async transform(change: (current: AssistantSettings) => Partial<AssistantSettings>): Promise<AssistantSettings> {
    const apply = async () => this.applyUpdate(change(await this.read()));
    const run = this.queue.then(apply, apply);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Records approved skill digests without replacing the ones already there.
   *
   * `update` replaces a field wholesale, so a caller merging on its own has to read first — and that
   * read happens outside the serialized section, which is exactly where two callers lose one of the
   * two writes. Merging inside is the only version of this that cannot race.
   */
  async mergeSkillDigests(digests: Readonly<Record<string, string>>): Promise<AssistantSettings> {
    const run = this.queue.then(
      () => this.applyUpdate({}, digests),
      () => this.applyUpdate({}, digests),
    );
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async applyUpdate(
    patch: Partial<AssistantSettings>,
    mergeDigests?: Readonly<Record<string, string>>,
  ): Promise<AssistantSettings> {
    const current = await this.read();
    const next: AssistantSettings = {
      skillIds: patch.skillIds ?? current.skillIds,
      workflowPrompt: (patch.workflowPrompt ?? current.workflowPrompt ?? DEFAULT_WORKFLOW_PROMPT).slice(0, MAX_SYSTEM_PROMPT_CHARS),
      retention: patch.retention ?? current.retention ?? { ordinaryDays: this.legacyRetentionDays, completedWorkspaceDays: null },
      executionMode: patch.executionMode ?? current.executionMode ?? "native",
      translationConnections: patch.translationConnections ?? current.translationConnections ?? {},
      translationModels: patch.translationModels ?? current.translationModels ?? {},
      mcpDefaults: patch.mcpDefaults ?? current.mcpDefaults ?? {},
      mcpSkillApprovals: patch.mcpSkillApprovals ?? current.mcpSkillApprovals ?? {},
      mcpSkillsMigrated: patch.mcpSkillsMigrated ?? current.mcpSkillsMigrated ?? false,
      mcpToolRules: patch.mcpToolRules ?? current.mcpToolRules ?? {},
      mcpPolicyMigrated: patch.mcpPolicyMigrated ?? current.mcpPolicyMigrated ?? [],
      immediateHandoffs: patch.immediateHandoffs ?? current.immediateHandoffs ?? false,
      systemPrompt: (patch.systemPrompt ?? current.systemPrompt).slice(0, MAX_SYSTEM_PROMPT_CHARS),
      mcpProviders: patch.mcpProviders ?? current.mcpProviders,
      mcpSkillDigests: mergeDigests
        ? { ...current.mcpSkillDigests, ...mergeDigests }
        : patch.mcpSkillDigests ?? current.mcpSkillDigests,
      mcpAutoAllow: patch.mcpAutoAllow ?? current.mcpAutoAllow,
    };

    await mkdir(this.dataDir, { recursive: true });
    // Unique per write, not per process: two concurrent updates sharing one temp path race, and the
    // loser's rename fails with ENOENT after the winner moved the file out from under it — a settings
    // save that throws for a reason nothing in the caller can explain.
    // Temp file plus rename: a crash mid-write must not leave a truncated settings file that the
    // next start silently reads as "everything disabled, prompt gone".
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(next, null, 2), "utf8");
    await rename(temporary, this.file);
    this.cached = withCoreDefaults(next);
    return this.cached;
  }

  /**
   * Drops toggles for apps that are no longer installed, so an uninstall-reinstall cycle cannot
   * silently resurrect a provider the operator had enabled under an earlier install.
   */
  async prune(installedAppIds: readonly string[]): Promise<AssistantSettings> {
    const current = await this.read();
    const installed = new Set(installedAppIds);
    // Core is never in the installed roster and is never pruned: dropping an explicit "off" here
    // would have the default put it straight back on at the next read.
    const keep = (source: Record<string, boolean>): Record<string, boolean> =>
      Object.fromEntries(
        Object.entries(source).filter(([appId]) => appId === CORE_PROVIDER_ID || installed.has(appId)),
      );

    const kept = keep(current.mcpProviders);
    // Pruned together, and this half matters more: a stale auto-allow row is a standing grant to an
    // app id. If that id were ever reinstalled by someone else, it would arrive pre-trusted.
    const keptAutoAllow = keep(current.mcpAutoAllow);

    if (
      Object.keys(kept).length === Object.keys(current.mcpProviders).length &&
      Object.keys(keptAutoAllow).length === Object.keys(current.mcpAutoAllow).length
    ) {
      return current;
    }
    return this.update({ mcpProviders: kept, mcpAutoAllow: keptAutoAllow });
  }
}

function validTranslationModels(value: unknown): value is NonNullable<AssistantSettings["translationModels"]> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.entries(value).every(([kind, model]) => ["codex", "claude"].includes(kind) && isTranslationModel(model)));
}

function validTranslationConnections(value: unknown): value is NonNullable<AssistantSettings["translationConnections"]> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.entries(value).every(([kind, binding]) => ["codex", "claude"].includes(kind)
      && (binding === null || (typeof binding === "object" && typeof binding.connectionId === "string"
        && Number.isSafeInteger(binding.connectionRevision) && binding.connectionRevision > 0 && binding.harnessKind === kind
        && (binding.connectionIdentity === undefined || typeof binding.connectionIdentity === "string")))));
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function isBooleanRecord(value: unknown): value is Record<string, boolean> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "boolean")
  );
}
