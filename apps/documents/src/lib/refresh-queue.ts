export type RefreshRequest = { repositories?: string[]; manual: boolean };

// One load at a time. Notifications received during a load are merged into one follow-up;
// they never abort useful work. Manual refresh waits for that load but skips the quiet interval.
export function createRefreshQueue(
  load: (request: RefreshRequest, signal: AbortSignal) => Promise<void>,
  interval = 5000,
) {
  let stopped = false;
  let active: AbortController | null = null;
  let pending: RefreshRequest | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let completedAt = -Infinity;
  function schedule() {
    if (stopped || active || !pending || document.visibilityState !== "visible") return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void run(); }, pending.manual ? 0 : Math.max(0, completedAt + interval - Date.now()));
  }
  async function run() {
    if (!pending || stopped || document.visibilityState !== "visible") return;
    const request = pending;
    pending = null;
    const controller = new AbortController();
    active = controller;
    try { await load(request, controller.signal); }
    catch { /* The consumer reports load errors; a failure must not strand subsequent refreshes. */ }
    finally {
      if (active === controller) active = null;
      completedAt = controller.signal.aborted ? -Infinity : Date.now();
      schedule();
    }
  }
  function request(repositories?: string[], manual = false) {
    if (stopped) return;
    pending = pending ? {
      repositories: pending.repositories && repositories ? [...new Set([...pending.repositories, ...repositories])] : undefined,
      manual: pending.manual || manual,
    } : { repositories, manual };
    schedule();
  }
  function visibility() {
    if (document.visibilityState === "visible") { completedAt = -Infinity; request(); }
    else {
      if (timer) clearTimeout(timer);
      timer = null;
      active?.abort();
      pending = { manual: pending?.manual ?? false }; // Resume with an authoritative full snapshot.
    }
  }
  document.addEventListener("visibilitychange", visibility);
  return {
    request,
    dispose() {
      stopped = true;
      active?.abort();
      if (timer) clearTimeout(timer);
      pending = null;
      document.removeEventListener("visibilitychange", visibility);
    },
  };
}

export type SourceChange = { revision: number; full: number; repositories: Record<string, number> };
export function recordSourceChange(previous: SourceChange, repositories?: string[]): SourceChange {
  const revision = previous.revision + 1;
  return repositories ? { ...previous, revision, repositories: { ...previous.repositories, ...Object.fromEntries(repositories.map(id => [id, revision])) } }
    : { ...previous, revision, full: revision };
}
export function changedRepositories(change: SourceChange, since: number) {
  return change.full > since ? undefined : Object.keys(change.repositories).filter(id => change.repositories[id] > since);
}
