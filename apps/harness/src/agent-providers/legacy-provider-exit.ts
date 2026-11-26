import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import type { ProviderRef } from "@hosty-sdk/app/agent-sessions";

type LegacyAttempt = {
  provider: ProviderRef;
  runId: string;
  generation: string;
  sessionId: string;
  archivedProviderSession?: string;
};
type JsonRecord = Record<string, unknown>;

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const metadataLimit = 64 * 1024;
const executionLimit = 80 * 1024 * 1024;

function identifier(value: unknown): value is string {
  return typeof value === "string" && uuid.test(value);
}

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function installationTime(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // Core's System.Text.Json trims trailing fractional zeroes. PanelIdentity's O format keeps them.
  const timestamp = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,7}))?([+-]\d\d:\d\d)$/.exec(value);
  if (!timestamp || !Number.isFinite(Date.parse(value))) return undefined;
  return timestamp[1] + "." + (timestamp[2] ?? "").padEnd(7, "0") + timestamp[3];
}

function matchesProvider(value: unknown, provider: ProviderRef): boolean {
  const ref = record(value);
  const installedAt = installationTime(provider.installationId);
  return !!ref && installedAt !== undefined && ref.appId === provider.appId && installationTime(ref.installationId) === installedAt
    && ref.key === provider.key && (ref.implementationId ?? null) === (provider.implementationId ?? null);
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function readEvidence(root: string, parts: string[], maxBytes: number): Promise<JsonRecord | undefined> {
  let file = root;
  let found = false;
  try {
    for (const directory of parts.slice(0, -1)) {
      file = path.join(file, directory);
      if (!(await lstat(file)).isDirectory()) throw new Error("Invalid legacy evidence directory.");
    }
    file = path.join(file, parts[parts.length - 1]!);
    const expected = await lstat(file);
    found = true;
    if (!expected.isFile() || expected.nlink !== 1 || expected.size > maxBytes || await realpath(file) !== file)
      throw new Error("Invalid legacy evidence file.");
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || !sameFile(expected, opened)) throw new Error("Legacy evidence changed while opening.");
      const buffer = Buffer.alloc(opened.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length !== opened.size || !sameFile(opened, await handle.stat()) || !sameFile(opened, await lstat(file))
          || await realpath(file) !== file) throw new Error("Legacy evidence changed while reading.");
      const parsed = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length))));
      if (!parsed) throw new Error("Invalid legacy evidence record.");
      return parsed;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!found && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function continuationsClosed(value: unknown): boolean {
  return value === undefined || Array.isArray(value) && value.every(item => record(item)?.state === "superseded");
}

function aggregateMatches(aggregate: JsonRecord, attempt: LegacyAttempt, nativeGeneration: string): boolean {
  const session = record(aggregate.session);
  const sessionRef = record(session?.ref);
  const run = record(record(aggregate.runs)?.[attempt.runId]);
  const snapshot = record(run?.snapshot);
  const runRef = record(snapshot?.ref);
  if (aggregate.version !== 1 || aggregate.id !== attempt.sessionId || sessionRef?.id !== attempt.sessionId
      || !matchesProvider(sessionRef.provider, attempt.provider) || !run || run.nativeGeneration !== nativeGeneration
      || snapshot?.sessionId !== attempt.sessionId || snapshot.generation !== attempt.generation
      || runRef?.id !== attempt.runId || !matchesProvider(runRef.provider, attempt.provider)) return false;
  const release = record(run.workspaceRelease);
  if (run.reservedFor != null || (run.workspaces !== undefined && !Array.isArray(run.workspaces))
      || ((Array.isArray(run.workspaces) && run.workspaces.length > 0) || run.workspaceRelease !== undefined) && release?.state !== "released"
      || !continuationsClosed(snapshot.pendingContinuations)) return false;
  const controls = run.controls === undefined ? {} : record(run.controls);
  return !!controls && Object.values(controls).every(control => {
    const receipt = record(record(control)?.receipt);
    return !!receipt && (receipt.continuation == null || record(receipt.continuation)?.state === "superseded");
  });
}

/** Read exact provider-owned v1 closure receipts without replaying controls or changing the files. */
export async function verifyLegacyProviderExit(providerRoot: string, attempt: LegacyAttempt): Promise<boolean> {
  const { provider, runId, generation, sessionId, archivedProviderSession } = attempt;
  const installedAt = installationTime(provider.installationId);
  if (!path.isAbsolute(providerRoot) || !identifier(runId) || !identifier(generation) || !identifier(sessionId) || !installedAt) return false;
  const root = path.resolve(providerRoot);
  try {
    if (root === path.parse(root).root || !(await lstat(root)).isDirectory() || await realpath(root) !== root) return false;
    const state = await readEvidence(root, ["state.json"], 1024 * 1024);
    const app = record(state?.app);
    const currentInstallation = installationTime(app?.installedAt);
    if (app?.id !== provider.appId || !currentInstallation) return false;
    const journal = await readEvidence(root, ["data", "execution-journal", runId + ".json"], executionLimit);
    const receipt = record(journal?.receipt);
    if (journal?.version !== 1 || receipt?.runId !== runId || receipt.conversationId !== sessionId
        || !identifier(receipt.generation) || receipt.exitConfirmed !== true
        || typeof receipt.state !== "string" || !["completed", "cancelled", "failed"].includes(receipt.state)
        || !Array.isArray(receipt.pending) || receipt.pending.length !== 0) return false;
    const aggregate = await readEvidence(root, ["data", "agent-sessions", sessionId + ".json"], executionLimit);
    if (aggregate && !aggregateMatches(aggregate, attempt, receipt.generation)) return false;
    let archivedAggregate: JsonRecord | undefined;
    if (archivedProviderSession !== undefined) {
      if (!path.isAbsolute(archivedProviderSession) || path.resolve(archivedProviderSession) !== archivedProviderSession) return false;
      const quarantine = ["data", "diagnostic-quarantine"];
      const relative = path.relative(path.join(root, ...quarantine), archivedProviderSession);
      if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(".." + path.sep)
          || !relative.endsWith(".json")) return false;
      archivedAggregate = await readEvidence(root, [...quarantine, ...relative.split(path.sep)], executionLimit);
      if (!archivedAggregate || !aggregateMatches(archivedAggregate, attempt, receipt.generation)) return false;
    }
    // A reinstall can retain the app's data. In that case only the original provider aggregate
    // binds these otherwise installation-neutral journal and process receipts to the old identity.
    if (currentInstallation !== installedAt && !aggregate && !archivedAggregate) return false;
    const nativePath = ["data", "native-processes", runId, generation];
    const manifest = await readEvidence(root, [...nativePath, "manifest.json"], metadataLimit);
    if (manifest?.version !== 1 || manifest.runId !== runId || manifest.generation !== generation
        || manifest.sealed !== true || manifest.sdkStopConfirmed !== true || typeof manifest.producerPid !== "number"
        || !Number.isSafeInteger(manifest.producerPid) || manifest.producerPid <= 0 || !identifier(manifest.producerNonce)
        || !Array.isArray(manifest.spawns) || manifest.spawns.length > 256 || !manifest.spawns.every(identifier)
        || new Set(manifest.spawns).size !== manifest.spawns.length) return false;
    for (const nonce of manifest.spawns) {
      const child = await readEvidence(root, [...nativePath, nonce + ".json"], metadataLimit);
      if (child?.version !== 1 || child.runId !== runId || child.generation !== generation
          || child.nonce !== nonce || child.state !== "stopped" || child.treeStopped !== true) return false;
      if (process.platform === "win32" && child.mechanism !== "windows-not-started.1"
          && !(child.mechanism === "windows-job.1" && child.activeProcesses === 0 && child.knownHandlesClosed === true))
        return false;
    }
    return true;
  } catch {
    return false;
  }
}
