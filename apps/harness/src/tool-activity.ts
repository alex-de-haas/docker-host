import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ToolActivityReporter, ToolActivityValue } from "@hosty-sdk/app/tool-activity/server";
import type { SessionManager } from "./sessions/manager.js";

export type SessionToolActivity = { userId: string; status: string; pending: number };
export function aggregateToolActivity(sessions: SessionToolActivity[]): Map<string, ToolActivityValue> {
  const groups = new Map<string, SessionToolActivity[]>();
  for (const session of sessions) {
    if (!session.userId) continue;
    const group = groups.get(session.userId) ?? [];
    group.push(session); groups.set(session.userId, group);
  }
  return new Map([...groups].map(([userId, group]) => {
    const failed = group.filter(s => s.status === "failed").length;
    const waiting = group.filter(s => s.status === "awaiting_approval" || s.status === "awaiting_question"
      || s.status === "running" && s.pending > 0)
      .reduce((count, s) => count + Math.max(1, s.pending), 0);
    const working = group.filter(s => s.status === "running").length;
    const value: ToolActivityValue = failed ? { state: "failed", count: Math.min(failed, 9999) }
      : waiting ? { state: "needs-you", count: Math.min(waiting, 9999) }
      : working ? { state: "working", count: Math.min(working, 9999) } : { state: "idle" };
    return [userId, value];
  }));
}

/** Persist owners before reporting attention; retain deleted owners until Core acknowledges idle. */
export class ToolActivityOwners {
  private readonly file: string;
  private active = new Set<string>();
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly dataDir: string) { this.file = path.join(dataDir, "tool-activity-owners.json"); }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.pending.catch(() => undefined).then(action);
    this.pending = result;
    return result;
  }

  private async read(): Promise<Set<string>> {
    try {
      const owners: unknown = JSON.parse(await readFile(this.file, "utf8"));
      if (!Array.isArray(owners) || owners.some(owner => typeof owner !== "string" || !owner))
        throw new Error("Invalid tool activity owner journal.");
      return new Set(owners as string[]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
      throw error;
    }
  }

  private async write(owners: Set<string>): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(`${this.file}.tmp`, JSON.stringify([...owners]), { mode: 0o600 });
    await rename(`${this.file}.tmp`, this.file);
  }

  reconcile(values: Map<string, ToolActivityValue>): Promise<Set<string>> {
    this.active = new Set([...values].filter(([, value]) => value.state !== "idle").map(([userId]) => userId));
    return this.serialize(async () => {
      const owners = await this.read();
      const before = owners.size;
      for (const userId of this.active) owners.add(userId);
      if (owners.size !== before) await this.write(owners);
      return owners;
    });
  }

  acknowledge(userId: string, panelId: string, value: ToolActivityValue): Promise<void> {
    if (panelId !== "assistant" || value.state !== "idle") return Promise.resolve();
    return this.serialize(async () => {
      // An old clear may finish while the next snapshot is being persisted.
      if (this.active.has(userId)) return;
      const owners = await this.read();
      if (owners.delete(userId)) await this.write(owners);
    });
  }
}

/** Observe manager transitions, including sessions with no browser subscribers. */
export function startHarnessToolActivity(manager: Pick<SessionManager, "subscribeToolActivity" | "toolActivitySnapshot">,
  reporter: Pick<ToolActivityReporter, "set" | "dispose">, owners?: ToolActivityOwners): () => Promise<void> {
  let known = new Set<string>(), stopped = false, reading = false, dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let refreshing: Promise<void> | undefined;
  const schedule = (delay = 50) => {
    dirty = true;
    if (stopped || reading || timer) return;
    timer = setTimeout(() => { timer = undefined; refreshing = refresh(); }, delay);
    timer.unref?.();
  };
  async function refresh() {
    if (stopped || reading) return;
    reading = true; dirty = false;
    try {
      const values = aggregateToolActivity(await manager.toolActivitySnapshot());
      if (owners) for (const userId of await owners.reconcile(values)) known.add(userId);
      if (stopped) return;
      for (const userId of known) if (!values.has(userId)) reporter.set(userId, "assistant", { state: "idle" });
      for (const [userId, value] of values) reporter.set(userId, "assistant", value);
      known = new Set(values.keys());
    } catch {
      // A transient record read must not terminate the observer.
      dirty = true;
    } finally {
      reading = false;
      if (dirty && !stopped) schedule(1000);
    }
  }
  const unsubscribe = manager.subscribeToolActivity(() => schedule());
  schedule(0);
  return async () => { stopped = true; unsubscribe(); clearTimeout(timer); await refreshing; await reporter.dispose(); };
}
