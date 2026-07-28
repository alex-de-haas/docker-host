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
