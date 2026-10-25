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
    const waiting = group.filter(s => s.status === "awaiting_approval" || s.status === "awaiting_question")
      .reduce((count, s) => count + Math.max(1, s.pending), 0);
    const working = group.filter(s => s.status === "running").length;
    const value: ToolActivityValue = failed ? { state: "failed", count: Math.min(failed, 9999) }
      : waiting ? { state: "needs-you", count: Math.min(waiting, 9999) }
      : working ? { state: "working", count: Math.min(working, 9999) } : { state: "idle" };
    return [userId, value];
  }));
}

/** Observe manager transitions, including sessions with no browser subscribers. */
export function startHarnessToolActivity(manager: Pick<SessionManager, "subscribeToolActivity" | "toolActivitySnapshot">,
  reporter: Pick<ToolActivityReporter, "set" | "dispose">): () => Promise<void> {
  let known = new Set<string>(), stopped = false, reading = false, dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (delay = 50) => {
    dirty = true;
    if (stopped || reading || timer) return;
    timer = setTimeout(() => { timer = undefined; void refresh(); }, delay);
    timer.unref?.();
  };
  async function refresh() {
    if (stopped || reading) return;
    reading = true; dirty = false;
    try {
      const values = aggregateToolActivity(await manager.toolActivitySnapshot());
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
  return async () => { stopped = true; unsubscribe(); clearTimeout(timer); await reporter.dispose(); };
}
