"use client";

import { useEffect, useState } from "react";
import type { AppSurfaceTab } from "./app-surface-tabs";

/**
 * Turns a declared surface into a URL that can actually be embedded.
 *
 * Shared by every placed surface — the Settings tab and the right panel — because the mechanism is
 * where the traps are, not the chrome around it. Embedding Core's resolved endpoint URL directly is
 * not enough: that frame carries no Hosty app session, so an app authenticating the ordinary way
 * loads unauthenticated and cannot recover, since `hosty:auth-required` recovery is scoped to the
 * active workspace. A launch code has to be minted first, and that is a round trip with a
 * stale-answer problem, so each context re-implementing it is each context getting one of the two
 * wrong.
 */
export function useAppSurfaceSrc(
  tab: AppSurfaceTab | null,
  openSurfaceFrame: (appId: string, embeddedUrl: string) => Promise<string>,
  couldNotOpenMessage: string,
  /**
   * Bumped to mint a fresh launch code for the surface already on screen — the recovery path for a
   * frame whose session expired. The previous answer stays until the new one lands, so recovery
   * does not blank the tool the operator is using.
   */
  reloadKey = 0,
): { src: string | null; error: string | null } {
  // Tagged with the surface it answers, so the answer can be *derived* rather than cleared. Clearing
  // it synchronously when the tab changes would work, but it makes the effect cascade a render, and
  // the tag is what actually states the rule: an answer belongs to one surface and to no other.
  //
  // Tagged by the tab's **key**, not by its URL. Two surfaces may legitimately resolve to the same
  // URL — one app declaring two panels on one path, or a settings and a panel surface that coincide
  // — and a URL tag would then let one tab's answer be read as the other's, which is the very
  // confusion the tag exists to prevent.
  const [resolved, setResolved] = useState<{ key: string; src: string | null; error: string | null } | null>(null);
  const embeddedUrl = tab?.embeddedUrl ?? null;
  const appId = tab?.appId ?? null;
  const key = tab?.key ?? null;

  useEffect(() => {
    if (!appId || !embeddedUrl || !key) {
      return;
    }

    // Dropped once the operator has moved on: a launch code is a round trip, and the answer for a
    // tab nobody is looking at must not land under the label of the one they are.
    let active = true;
    void openSurfaceFrame(appId, embeddedUrl)
      .then((launched) => {
        if (active) {
          setResolved({ key, src: launched, error: null });
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          setResolved({
            key,
            src: null,
            error: reason instanceof Error ? reason.message : couldNotOpenMessage,
          });
        }
      });

    return () => {
      active = false;
    };
  }, [appId, couldNotOpenMessage, embeddedUrl, key, openSurfaceFrame, reloadKey]);

  const current = resolved && resolved.key === key ? resolved : null;
  return { src: current?.src ?? null, error: current?.error ?? null };
}
