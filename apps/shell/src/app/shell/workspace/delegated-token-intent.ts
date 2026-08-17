// Shell's half of the delegated-token handshake that is not the protocol: the protocol itself
// (message types and the verified parser) ships in @hosty-sdk/app, so Shell consumes the published
// contract rather than keeping a private twin of it, exactly as it does for auth-required.
//
// What lives here is the policy the protocol deliberately does not encode — which app Shell hands a
// user-scoped credential to.

/** A token as Shell hands it to a frame: the credential plus when it stops being one. */
export type DelegatedTokenGrant = { token: string; expiresAt: string };

/** A grant is reused while at least this much of its lifetime is left. */
const DEFAULT_MIN_REMAINING_MS = 30_000;

/**
 * The per-app grant cache behind the responder. An embedded page asks per request, so without this
 * a page that reads and then saves sends Shell to Core twice for a credential it is already holding
 * a fresh copy of, and two parallel requests race into two mints.
 *
 * A cache that hands back a credential has two ways to be wrong, and both are covered here rather
 * than in the component that happens to own it:
 *
 * - **A refused token.** Only the app learns its token came back 401 — clocks need not agree on
 *   "expired" — so `refresh` discards the cached grant instead of replaying it.
 * - **A token from another session.** A mint that started before the user changed resolves after it,
 *   so clearing the map is not enough: `invalidateAll` also moves an epoch, and a mint from an older
 *   epoch is thrown away rather than cached or handed back.
 */
export type DelegatedTokenCache = {
  /** `refresh` = the app says the token it holds was refused, so a cached grant must not be reused. */
  issue(appId: string, refresh?: boolean): Promise<DelegatedTokenGrant>;
  invalidateAll(): void;
};

export function createDelegatedTokenCache(
  mint: (appId: string) => Promise<DelegatedTokenGrant>,
  options: { minRemainingMs?: number; now?: () => number } = {},
): DelegatedTokenCache {
  const minRemainingMs = options.minRemainingMs ?? DEFAULT_MIN_REMAINING_MS;
  const now = options.now ?? Date.now;
  const grants = new Map<string, { grant: DelegatedTokenGrant; expiresAtMs: number }>();
  const inFlight = new Map<string, Promise<DelegatedTokenGrant>>();
  let epoch = 0;

  return {
    issue(appId: string, refresh = false): Promise<DelegatedTokenGrant> {
      if (refresh) {
        grants.delete(appId);
      }

      const cached = grants.get(appId);
      if (cached && cached.expiresAtMs - now() > minRemainingMs) {
        return Promise.resolve(cached.grant);
      }

      // Joining a mint already in flight is safe even for a refresh: it is a call to Core made now,
      // so what it returns is newer than anything the frame could have been refused for.
      const pending = inFlight.get(appId);
      if (pending) {
        return pending;
      }

      const startedAt = epoch;
      const minting = mint(appId)
        .then((grant) => {
          if (startedAt !== epoch) {
            throw new Error("The signed-in user changed while the token was being issued.");
          }

          const expiresAtMs = Date.parse(grant.expiresAt);
          // An unparseable expiry caches as already-spent rather than as forever: the token is still
          // handed over (Core minted it), the next request just mints again instead of trusting it.
          grants.set(appId, { grant, expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : 0 });
          return grant;
        })
        .finally(() => {
          inFlight.delete(appId);
        });

      inFlight.set(appId, minting);
      return minting;
    },

    /** Called when the signed-in user changes: nothing minted before now may be reused. */
    invalidateAll(): void {
      epoch += 1;
      grants.clear();
      inFlight.clear();
    },
  };
}

/**
 * Whether the app shown in the workspace may be answered with a delegated token. The assistant
 * gateway alone qualifies: Shell already mints these tokens for it to run the chat panel, so
 * answering its settings page gives that app nothing it did not already hold. Every other frame
 * gets no handler at all — the workspace surface is generic, and answering whatever the operator
 * installed would widen the delegated-token trust story by accident rather than by decision.
 *
 * The gateway is identified by the app that declares the `ai-gateway` interface rather than by a
 * hard-coded id, because the assistant is meant to be replaceable: a second implementation inherits
 * the grant, and a host with no gateway installed grants nothing.
 */
export function appMayReceiveDelegatedToken(
  appId: string | undefined,
  assistantGatewayAppId: string | undefined,
): boolean {
  return Boolean(appId) && appId === assistantGatewayAppId;
}
