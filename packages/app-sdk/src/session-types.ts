// Shared session types with no DOM or framework dependency.
/**
 * Recovery classification of an app session, per the platform identity error contract:
 * - `not-present`: no token at all (recoverable — same handling as `expired`).
 * - `active`: token revalidated OK.
 * - `expired`: Core 401 — recoverable; re-authorize via the Shell (embedded) or Core `/open`
 *   (standalone).
 * - `forbidden`: Core 403 or a token minted for a different app — terminal; never
 *   auto-redirect (it would loop).
 * - `unavailable`: Core unreachable, slow, or answering garbage — transient; keep the
 *   cookie and offer a retry.
 * - `misconfigured`: the app itself is broken (no service token / no Core origin) — an
 *   operator problem; signing in cannot fix it, so never offer a login.
 */

export type AppSessionStatus =
  | "not-present"
  | "active"
  | "expired"
  | "forbidden"
  | "unavailable"
  | "misconfigured";

/** Failure statuses (everything but `active`). */
export type AppSessionFailureStatus = Exclude<AppSessionStatus, "active">;

export interface SessionRecoveryParams {
  appId: string | null;
  corePublicOrigin: string | null;
  appAuthProtocol: 1 | 2 | null;
}
