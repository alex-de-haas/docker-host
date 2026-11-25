import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentResponseInput, AgentRunControlInput } from "@hosty-sdk/app/agent";
import type { ExecutionDriver } from "./controller.js";
import type { ProviderStore, RunRecord } from "./store.js";

/** This database holds only an OS file lock. SQLite releases it if the owning process dies. */
export function acquireAttemptScope(directory: string, id: string): DatabaseSync | undefined {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) throw new Error("Invalid execution attempt ID.");
  const db = new DatabaseSync(path.join(directory, id + ".scope"));
  try {
    db.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
    return db;
  } catch (error) {
    db.close();
    if ((error as { errcode?: number }).errcode === 5) return undefined;
    throw error;
  }
}

export function needsSupervisor(run: RunRecord): boolean {
  if (Object.values(run.controls).some(control => control.receipt.state === "accepted")) return true;
  if (!run.input || run.reservedFor) return false;
  return !run.snapshot.stopConfirmed || run.workspaceRelease?.state !== "released"
    || run.snapshot.pending.some(decision => decision.delivery === "next_turn")
    || Object.values(run.decisionLinks ?? {}).some(id => !run.retiredDecisionIds?.includes(id))
    || Object.values(run.decisionDeliveries ?? {}).some(delivery => !delivery.done);
}

/**
 * The public service commits its desired state and commands to the attempt database.
 * The child owns the execution, MCP listener and native credentials independently of HTTP clients.
 */
export class AttemptSupervisors implements ExecutionDriver {
  readonly durableCommands = true;
  private readonly launches = new Map<string, number>();
  private timer?: NodeJS.Timeout;
  private scan?: Promise<void>;
  private closed = false;
  readonly directory: string;
  constructor(private readonly store: ProviderStore, data: string, private readonly entry = process.env.HOSTY_PROVIDER_ENTRY ?? process.argv[1]!) {
    this.directory = path.join(data, "attempt-scopes-v2");
  }
  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.reconcile();
    this.timer = setInterval(() => { void this.reconcile().catch(() => {}); }, 2000);
    this.timer.unref();
  }
  private reconcile(): Promise<void> {
    return this.scan ??= (async () => {
      for (const session of await this.store.recordsDue()) {
        for (const run of Object.values(session.runs)) if (needsSupervisor(run)) this.wake(run.snapshot.ref.id);
      }
      for (const [id, until] of this.launches) if (until <= Date.now()) this.launches.delete(id);
    })().finally(() => { this.scan = undefined; });
  }
  private wake(id: string): void {
    if (this.closed || (this.launches.get(id) ?? 0) > Date.now()) return;
    const available = acquireAttemptScope(this.directory, id);
    if (!available) return;
    available.close();
    this.launches.set(id, Date.now() + 2000);
    const loader = this.entry.endsWith(".ts") ? process.execArgv : [];
    const child = spawn(process.execPath, [...loader, this.entry, "--hosty-attempt", id], {
      detached: true, stdio: "ignore", windowsHide: true,
    });
    child.once("error", () => { this.launches.delete(id); });
    child.unref();
  }
  async start(_sessionId: string, id: string): Promise<void> { this.wake(id); }
  async cancel(id: string, _requestId: string): Promise<void> { this.wake(id); }
  async respond(id: string, _input: AgentResponseInput): Promise<void> { this.wake(id); }
  async control(id: string, _input: AgentRunControlInput): Promise<void> { this.wake(id); }
  async retirementEvidence(run: RunRecord): Promise<{ nativeGeneration: string; nativeRevision: number }> {
    if (!run.snapshot.stopConfirmed || !run.nativeGeneration || run.nativeRevision < 0)
      throw new Error("The execution scope has not confirmed physical closure.");
    return { nativeGeneration: run.nativeGeneration, nativeRevision: run.nativeRevision };
  }
  async releaseRetired(id: string): Promise<void> { this.wake(id); }
  async synchronize(_id: string): Promise<void> { /* reads use the supervisor's committed cursor */ }
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    await this.scan;
  }
}
