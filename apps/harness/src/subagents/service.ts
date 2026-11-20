import { randomUUID } from "node:crypto";
import type { AgentRunSnapshot } from "@hosty-sdk/app/agent";
import { AppContextError } from "../sessions/app-context.js";
import { messageRequestId, type SessionRecord, type SessionStore } from "../sessions/store.js";
import type { AgentProfile } from "../profiles/types.js";
import { childFinished, completedChildren, observeChild, type ChildLaunch, type ChildWait, type SessionFamily, type SessionSubagent } from "./types.js";

export const stoppedAssignment = { code: "subagent_stopped_before_start", message: "The child assignment was stopped before the provider started it." };

type Ports = {
  parent(id: string): Promise<SessionRecord | null>;
  profiles(): Promise<AgentProfile[]>;
  launch(parent: SessionRecord, launch: ChildLaunch): Promise<void>;
  resume(parent: SessionRecord, wait: ChildWait): Promise<void>;
  publish(parent: string, children: SessionSubagent[], pending: boolean, recovering: boolean): Promise<void>;
  serialize<T>(key: string, action: () => Promise<T>): Promise<T>;
  track(action: Promise<void>): void;
  stopping(): boolean;
  admitted(id: string, runId: string): Promise<void>;
  failedLaunch(parent: string, id: string, stoppedRunId?: string): Promise<void>;
  joinWorkspace(parent: SessionRecord, childId: string): Promise<void>;
  workspace(parent: SessionRecord): Promise<ChildLaunch["workspace"]>;
};

function conflict(message: string): never { throw new AppContextError(409, "subagent_request_conflict", message); }
function invalid(): never { throw new AppContextError(400, "subagent_request_invalid", "Use a saved profile revision, a prompt and the original request identity."); }
function requiredId(value: unknown): string {
  try { return messageRequestId(value); } catch { return invalid(); }
}
function unavailable(): never { throw new AppContextError(404, "subagent_missing", "The child chat does not belong to this conversation."); }

export class SessionSubagents {
  private readonly scheduled = new Set<string>();
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private readonly retryDelays = new Map<string, number>();
  private retryLater(id: string): void {
    if (this.ports.stopping() || this.retryTimers.has(id)) return;
    const delay = this.retryDelays.get(id) ?? 1000;
    this.retryDelays.set(id, Math.min(delay * 2, 30000));
    const timer = setTimeout(() => { this.retryTimers.delete(id); this.kick(id); }, delay);
    timer.unref();
    this.retryTimers.set(id, timer);
  }
  close(): void {
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear(); this.retryDelays.clear();
  }
  constructor(private readonly store: SessionStore, private readonly ports: Ports) {}

  private async parent(id: string) {
    const record = await this.ports.parent(id);
    if (!record || record.taskExecutionId || record.handoffPending) throw new AppContextError(404, "conversation_missing", "Ordinary chat not found.");
    return record;
  }
  private async change<T>(id: string, action: (family: SessionFamily, save: () => Promise<void>) => Promise<T>, recovering = false): Promise<T> {
    return this.ports.serialize("family:" + id, async () => {
      const family = await this.store.readSessionFamily(id);
      const publish = () => this.ports.publish(id, family.launches.map(launch => launch.child),
        family.launches.some(launch => !childFinished(launch.child) || launch.workspaceCheck === "pending") || family.waits.some(wait => wait.state === "pending" || wait.state === "ready"), recovering);
      const save = async () => { await this.store.saveSessionFamily(id, family); await publish(); };
      return action(family, save);
    });
  }

  async action(id: string, action: string, input: Record<string, unknown>, revalidate: () => Promise<void>): Promise<unknown> {
    await revalidate();
    const parent = await this.parent(id);
    if (action === "subagent-profiles") return { profiles: (await this.ports.profiles()).map(({ id, name, description, revision, model }) => ({ id, name, description, revision, model })) };
    if (action === "subagent-status") return this.change(id, async family => {
      if (input.childSessionId === undefined) return { children: family.launches.map(launch => launch.child) };
      const found = family.launches.find(launch => launch.child.id === input.childSessionId);
      if (!found) return unavailable();
      return { child: found.child };
    });
    const requestId = requiredId(input.requestId);
    if (action === "subagent-spawn") {
      if (typeof input.profileId !== "string" || !Number.isSafeInteger(input.profileRevision)
        || typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 32000
        || input.title !== undefined && (typeof input.title !== "string" || !input.title.trim() || input.title.length > 200)) return invalid();
      const { profileId, prompt } = input, profileRevision = input.profileRevision as number, title = input.title as string | undefined;
      const child = await this.change(id, async (family, save) => {
        await revalidate();
        const existing = family.launches.find(launch => launch.requestId === requestId);
        if (existing) {
          if (existing.child.profileId !== profileId || existing.profileRevision !== profileRevision
            || existing.child.prompt !== prompt || existing.title !== title) conflict("Reuse the original launch arguments.");
          return existing.child;
        }
        const profile = (await this.ports.profiles()).find(value => value.id === profileId && value.revision === profileRevision);
        if (!profile) throw new AppContextError(409, "profile_changed", "Read the current profile before launching this child.");
        const child: SessionSubagent = { id: randomUUID(), profileId, profileName: profile.name, prompt, status: "starting", chatAvailable: false };
        family.launches.push({ child, profileRevision, requestId, runId: randomUUID(), title, dispatched: false,
          workspace: parent.workspaceAssociation ?? undefined, autonomy: parent.autonomy ?? "normal", appIds: parent.appIds ?? [] });
        await save();
        return child;
      });
      this.kick(id);
      return { childSessionId: child.id, child };
    }
    if (action !== "subagent-wait" || !Array.isArray(input.childSessionIds)
      || !input.childSessionIds.length || input.childSessionIds.length > 100 || !input.childSessionIds.every(value => typeof value === "string") || !["any", "all"].includes(String(input.mode))) return invalid();
    const ids = [...new Set(input.childSessionIds as string[])].sort(), mode = input.mode as "any" | "all";
    const result = await this.change(id, async (family, save) => {
      await revalidate();
      if (ids.some(childId => !family.launches.some(launch => launch.child.id === childId))) return unavailable();
      const existing = family.waits.find(wait => wait.requestId === requestId);
      if (existing) {
        if (existing.mode !== mode || JSON.stringify(existing.childSessionIds) !== JSON.stringify(ids)) conflict("Reuse the original wait arguments.");
        return this.waitResult(existing);
      }
      const wait: ChildWait = { requestId, childSessionIds: ids, mode, state: "pending", runId: randomUUID() };
      wait.outcomes = completedChildren(family, wait);
      if (wait.outcomes) wait.state = "returned";
      family.waits.push(wait);
      await save();
      return this.waitResult(wait);
    });
    this.kick(id);
    return result;
  }

  private waitResult(wait: ChildWait) {
    return { requestId: wait.requestId, state: wait.state, ...(wait.outcomes ? { children: wait.outcomes } : {}), ...(wait.error ? { error: wait.error } : {}) };
  }

  kick(id: string) {
    if (this.ports.stopping() || this.scheduled.has(id)) return;
    this.scheduled.add(id);
    const work = new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
      this.scheduled.delete(id);
      if (!this.ports.stopping()) await this.advance(id);
    });
    this.ports.track(work);
  }

  private readonly dispatching = new Set<string>();

  private dispatch(key: string, action: () => Promise<void>): void {
    if (this.dispatching.has(key) || this.ports.stopping()) return;
    this.dispatching.add(key);
    this.ports.track(action().finally(() => this.dispatching.delete(key)));
  }

  private async advance(id: string): Promise<void> {
    const parent = await this.ports.parent(id);
    if (!parent || parent.storageRecovery) return;
    const work = await this.change(id, async (family, save) => {
      let changed = false;
      for (const wait of family.waits) {
        if (wait.state !== "pending") continue;
        wait.outcomes = completedChildren(family, wait);
        if (wait.outcomes) { wait.state = "ready"; changed = true; }
      }
      if (changed) await save();
      return { launches: family.launches.filter(launch => !launch.dispatched && !childFinished(launch.child)),
        workspaces: family.launches.filter(launch => launch.workspaceCheck === "pending"), waits: family.waits.filter(wait => wait.state === "ready") };
    });
    // A slow provider admission does not hold the family database lane or block a second
    // spawn, status read or wait registration. Each admitted intent keeps its own turn ID.
    for (const launch of work.launches) this.dispatch(launch.runId, () => this.advanceLaunch(parent, launch));
    if (work.workspaces.length) {
      this.dispatch("workspace:" + id, () => this.adoptWorkspace(parent, work.workspaces[0]!));
      return;
    }
    for (const wait of work.waits) this.dispatch(wait.runId, () => this.advanceWait(parent, wait));
    if (!work.launches.length && !work.waits.length) this.retryDelays.delete(id);
  }

  private async adoptWorkspace(parent: SessionRecord, launch: ChildLaunch): Promise<void> {
    let detail: string | undefined;
    try { await this.ports.joinWorkspace(parent, launch.child.id); }
    catch (error) {
      if (this.retryable(error)) this.retryLater(parent.id);
      if (this.failure(error).status !== "failed") return;
      detail = error instanceof Error ? error.message : "The parent could not join the child workspace.";
    }
    await this.change(parent.id, async (family, save) => {
      const current = family.launches.find(row => row.runId === launch.runId);
      if (current?.workspaceCheck !== "pending") return;
      current.workspaceCheck = "complete";
      if (detail) current.child.detail = detail;
      await save();
    });
    this.kick(parent.id);
  }

  async workspaceChanged(parent: string, childId: string): Promise<void> {
    if (!await this.ports.parent(parent)) return;
    await this.change(parent, async (family, save) => {
      const launch = family.launches.find(row => row.child.id === childId);
      if (!launch || launch.workspace || launch.workspaceCheck === "pending") return;
      launch.workspaceCheck = "pending";
      await save();
    });
    this.kick(parent);
  }

  private async settleStoppedAssignment(parent: SessionRecord, assignment: ChildLaunch): Promise<boolean> {
    const { child: { id }, runId } = assignment;
    const receipt = await this.store.readMessageReceipt(id, runId);
    if (receipt?.state !== "rejected" || receipt.actorUserId !== parent.createdBy || receipt.error?.code !== stoppedAssignment.code) return false;
    await this.ports.failedLaunch(parent.id, id, runId);
    await this.change(parent.id, async (family, save) => {
      const launch = family.launches.find(row => row.child.id === id && row.runId === runId);
      if (!launch || launch.dispatched || childFinished(launch.child)) return;
      const { detail: _detail, ...child } = launch.child;
      launch.child = { ...child, chatAvailable: true, status: "cancelled", result: stoppedAssignment.message };
      await save();
    });
    this.kick(parent.id);
    return true;
  }

  private async advanceLaunch(parent: SessionRecord, launch: ChildLaunch): Promise<void> {
    let next: SessionSubagent;
    let dispatched = false;
    if (await this.settleStoppedAssignment(parent, launch)) return;
    try {
      if (!launch.workspace && !launch.workspaceResolved) {
        const workspace = await this.ports.workspace(parent);
        await this.change(parent.id, async (family, save) => {
          const saved = family.launches.find(row => row.runId === launch.runId);
          if (!saved || saved.dispatched) return;
          saved.workspace = workspace; saved.workspaceResolved = true;
          await save();
        });
        launch.workspace = workspace;
      }
      await this.ports.launch(parent, launch);
      const { detail: _detail, ...child } = launch.child;
      next = { ...child, chatAvailable: true, status: "running" };
      dispatched = true;
    } catch (error) {
      if (await this.settleStoppedAssignment(parent, launch)) return;
      const child = await this.ports.parent(launch.child.id);
      next = { ...launch.child, chatAvailable: !!child, ...this.failure(error) };
      if (this.retryable(error)) this.retryLater(parent.id);
      if (next.status === "failed" && child) await this.ports.failedLaunch(parent.id, child.id);
    }
    await this.change(parent.id, async (family, save) => {
      const current = family.launches.find(row => row.runId === launch.runId);
      if (!current || current.dispatched || childFinished(current.child)) return;
      if (JSON.stringify(next) === JSON.stringify(current.child) && current.dispatched === dispatched) return;
      current.dispatched = dispatched;
      current.child = next;
      await save();
      if (childFinished(next)) this.kick(parent.id);
    });
  }

  private async advanceWait(parent: SessionRecord, wait: ChildWait): Promise<void> {
    let error: string | undefined;
    try { await this.ports.resume(parent, wait); }
    catch (cause) {
      if (this.retryable(cause)) this.retryLater(parent.id);
      if (this.failure(cause).status !== "failed") return;
      error = cause instanceof Error ? cause.message : "The result could not be delivered.";
    }
    await this.change(parent.id, async (family, save) => {
      const current = family.waits.find(row => row.runId === wait.runId);
      if (current?.state !== "ready") return;
      current.state = error ? "failed" : "delivered";
      current.error = error;
      await save();
    });
  }

  private retryable(error: unknown): boolean {
    const reason = error as { status?: number; code?: string; retryable?: boolean };
    const transportInterrupted = error instanceof TypeError && error.message === "fetch failed"
      || error instanceof DOMException && error.name === "TimeoutError";
    return transportInterrupted || reason.retryable === true || reason.status === 503 || reason.status === 429 || ["provider_busy", "provider_unavailable", "workspace_revision_conflict"].includes(reason.code ?? "");
  }
  private failure(error: unknown): Pick<SessionSubagent, "status" | "result" | "detail"> {
    const reason = error as { status?: number; code?: string; message?: string };
    if (this.retryable(error) || reason.status === 401 || ["provider_busy", "message_outcome_unknown", "subagent_busy", "queue_pending", "stop_unconfirmed",
      "source_admission_recovery_required", "provider_request_unresolved", "session_busy", "workspace_credentials_required"].includes(reason.code ?? ""))
      return { status: "unknown", detail: reason.message };
    return { status: "failed", result: reason.message ?? "The child could not start." };
  }

  async observe(parent: string, id: string, snapshot: AgentRunSnapshot, stateOnly: boolean) {
    if (!await this.ports.parent(parent)) return;
    await this.change(parent, async (family, save) => {
      const launch = family.launches.find(row => row.child.id === id && row.runId === snapshot.ref.id);
      if (!launch) return;
      const previous = launch.child;
      const next = observeChild(previous, snapshot, stateOnly);
      await this.ports.admitted(id, launch.runId);
      if (!launch.dispatched || JSON.stringify(next) !== JSON.stringify(previous)) {
        launch.dispatched = true;
        launch.child = { ...next, chatAvailable: true };
        if (!launch.workspace && !launch.workspaceCheck && childFinished(next)) launch.workspaceCheck = "pending";
        await save();
      }
    });
    this.kick(parent);
  }

  async cancelWaits(id: string): Promise<void> {
    await this.change(id, async (family, save) => {
      const pending = family.waits.filter(wait => wait.state === "ready" || wait.state === "pending");
      if (!pending.length) return;
      for (const wait of pending) wait.state = "cancelled";
      await save();
    });
  }

  async deleted(parent: string, id: string) {
    if (!await this.ports.parent(parent)) return;
    await this.change(parent, async (family, save) => {
      const launch = family.launches.find(row => row.child.id === id);
      if (!launch) return;
      launch.workspaceCheck = "complete";
      launch.child = { ...launch.child, chatAvailable: false, status: childFinished(launch.child) ? launch.child.status : "cancelled" };
      await save();
    });
    this.kick(parent);
  }

  async recover(parent: SessionRecord) {
    const family = await this.store.readSessionFamily(parent.id);
    if (!family.launches.length && !family.waits.length) return;
    await this.change(parent.id, (_family, save) => save(), true);
    for (const launch of family.launches) {
      const record = await this.ports.parent(launch.child.id);
      if (!record && launch.child.chatAvailable) await this.deleted(parent.id, launch.child.id);
      else if (record?.parentSessionId === parent.id && !childFinished(launch.child)) {
        const current = record.providerExecution?.run;
        const history = await this.store.readHistoryRun(record.id, launch.runId);
        const retained = history?.snapshot ?? (current?.ref.id === launch.runId ? current : undefined);
        if (retained) {
          const stateOnly = !retained.result && retained.state === "succeeded" && (!history || !!history.clock && history.clock.details !== history.clock.lifecycle);
          await this.observe(parent.id, record.id, retained, stateOnly);
        }
      }
    }
    this.kick(parent.id);
  }
}
