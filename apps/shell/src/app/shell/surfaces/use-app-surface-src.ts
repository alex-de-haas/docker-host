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
): { src: string | null; error: string | null } {
  // Tagged with the surface it answers, so the answer can be *derived* rather than cleared. Clearing
  // it synchronously when the tab changes would work, but it makes the effect cascade a render, and
  // the tag is what actually states the rule: an answer belongs to one surface and to no other.
  const [resolved, setResolved] = useState<{ url: string; src: string | null; error: string | null } | null>(null);
  const embeddedUrl = tab?.embeddedUrl ?? null;
  const appId = tab?.appId ?? null;

  useEffect(() => {
    if (!appId || !embeddedUrl) {
      return;
    }

    // Dropped once the operator has moved on: a launch code is a round trip, and the answer for a
    // tab nobody is looking at must not land under the label of the one they are.
    let active = true;
    void openSurfaceFrame(appId, embeddedUrl)
      .then((launched) => {
        if (active) {
          setResolved({ url: embeddedUrl, src: launched, error: null });
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          setResolved({
            url: embeddedUrl,
            src: null,
            error: reason instanceof Error ? reason.message : couldNotOpenMessage,
          });
        }
      });

    return () => {
      active = false;
    };
  }, [appId, couldNotOpenMessage, embeddedUrl, openSurfaceFrame]);

  const current = resolved && resolved.url === embeddedUrl ? resolved : null;
  return { src: current?.src ?? null, error: current?.error ?? null };
}
