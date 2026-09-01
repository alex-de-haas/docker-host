import type { AppsResponse } from "./types";

// Kept a leaf module — types only, no runtime imports — so it stays directly testable under
// `node --test`, which cannot resolve the extensionless specifiers the stream client reaches for.
// The subscription is passed in rather than imported, which is also the honest shape: what this
// module owns is when a Shell apply counts as finished, not how hints reach the page.

/** How Core's record settled the Shell apply this page is waiting on. */
export type ShellUpdateOutcome =
  | { kind: "settled" }
  | { kind: "failed"; message: string }
  | { kind: "unresolved" };

/**
 * Subscribes to app-record change hints, returning an unsubscribe. `onSync` is expected to run on
 * connect and on every reconnect as well as per hint — the wait leans on that to survive a drop.
 */
export type SubscribeToAppChanges = (onSync: () => void | Promise<void>) => () => void;

/**
 * Past this the page stops waiting rather than hold the tab hostage. The apply is unaffected — it
 * runs on Core's own lifetime and the app row keeps rendering its progress.
 */
const SETTLE_TIMEOUT_MS = 10 * 60_000;

/**
 * Waits for Core to finish the detached apply of the Shell's own app.
 *
 * `POST /api/apps/{id}/update` returns as soon as the `"updating"` marker is persisted; the apply
 * (pull, stop, recreate) then runs on Core's lifetime. So the origin serving this page keeps
 * answering — from the *old* Shell — for as long as that takes, and "our origin responds" is not
 * evidence of anything. The record leaving `"updating"` is the completion signal; only after it does
 * probing our own origin mean "the new Shell is listening".
 *
 * No poll is needed. Every app-record commit publishes an `app.changed` hint, and Core stays up
 * across the Shell swap, so the event stream this page already holds is the one transport that
 * survives it. Hints carry no state we trust, so each one re-reads the list.
 */
export function waitForShellUpdateToSettle(options: {
  coreOrigin: string;
  shellAppId: string;
  subscribe: SubscribeToAppChanges;
  timeoutMs?: number;
}): Promise<ShellUpdateOutcome> {
  const { coreOrigin, shellAppId, subscribe } = options;
  return new Promise<ShellUpdateOutcome>((resolve) => {
    let unsubscribe: (() => void) | null = null;
    let settled = false;

    const finish = (outcome: ShellUpdateOutcome) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      unsubscribe?.();
      resolve(outcome);
    };

    const timer = setTimeout(() => finish({ kind: "unresolved" }), options.timeoutMs ?? SETTLE_TIMEOUT_MS);

    const readRecord = async () => {
      if (settled) {
        return;
      }

      try {
        const response = await fetch(`${coreOrigin}/api/apps`, { credentials: "include", cache: "no-store" });
        if (!response.ok) {
          return;
        }

        const shellApp = ((await response.json()) as AppsResponse).apps.find((app) => app.id === shellAppId);
        if (!shellApp) {
          // Removed mid-apply: nothing is coming back on this origin, so stop waiting for it.
          finish({ kind: "unresolved" });
          return;
        }

        if (shellApp.operationStatus === "updating") {
          return;
        }

        finish(
          shellApp.operationStatus === "failed"
            ? { kind: "failed", message: shellApp.lastError || "The Shell update failed on the host." }
            : { kind: "settled" },
        );
      } catch {
        // A failed read is not an outcome: the next hint, reconnect or visibility change re-reads.
        // Resolving here would reload the tab into a half-swapped Shell.
      }
    };

    unsubscribe = subscribe(readRecord);
    if (settled) {
      // The wait resolved (or timed out) before the subscription handle came back.
      unsubscribe();
    }
  });
}
