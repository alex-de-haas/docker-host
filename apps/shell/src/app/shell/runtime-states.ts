// The client-side mirror of Core's AppRuntimeStates predicates. Core deliberately splits one boolean
// into three questions, and the Shell has to ask the same three — a control that means "safe to do
// something destructive" must not be written as "not running", because that spelling also admits an
// app that is still shutting down. See docs/features/app-lifecycle-states/feature.md.
//
// `app-problems.ts` intentionally does NOT import this: it is kept free of runtime imports so it stays
// directly testable under `node --test`, which cannot resolve extensionless relative specifiers. Its
// one predicate is inlined there with a pointer back here.

/** Up and serving traffic — the only state an app may be opened or linked to in. */
export function isAppUp(state?: string | null) {
  return state === "running";
}

/** A lifecycle verb is in flight: show progress, and disable controls that would interfere. */
export function isAppBusy(state?: string | null) {
  return state === "starting" || state === "stopping";
}

/** Down with nothing operating on it — the only safe moment for a destructive action. */
export function isAppIdle(state?: string | null) {
  return state === "stopped";
}

export type AppStateFilter = "all" | "running" | "transitioning" | "attention" | "updates";

/** Shared by Dashboard counts and visible rows so each count describes its own result set. */
export function matchesAppStateFilter(
  app: { runtimeState?: string | null; operationStatus?: string | null; lastError?: string | null; restartRequired?: boolean; updateCheck?: { updateAvailable?: boolean; error?: string | null } | null },
  filter: AppStateFilter,
): boolean {
  switch (filter) {
    case "all": return true;
    case "running": return isAppUp(app.runtimeState);
    case "transitioning": return isAppBusy(app.runtimeState);
    case "updates": return Boolean(app.updateCheck?.updateAvailable);
    case "attention": return Boolean(app.restartRequired || app.updateCheck?.error || app.lastError || app.operationStatus === "failed" || app.runtimeState === "unknown");
  }
}

/** Name and technical ID are both searchable, independently of the active state filter. */
export function matchesAppSearch(app: { id: string; displayName: string }, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return !needle || app.displayName.toLowerCase().includes(needle) || app.id.toLowerCase().includes(needle);
}
