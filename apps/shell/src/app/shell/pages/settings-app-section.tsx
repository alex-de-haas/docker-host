"use client";

import { useEffect, useState } from "react";
import { Play, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { HostyResolvedTheme, HostyThemePreference } from "../types";
import { EmbeddedAppFrame } from "../embedding/embedded-app-frame";
import type { DelegatedTokenGrant } from "../workspace/delegated-token-intent";

/** One installed app's settings surface, as the Settings page consumes it. */
export type AppSettingsTab = {
  appId: string;
  label: string;
  /** The declared surface path, used to mint a launch code that lands on it. */
  path: string;
  // Null while the app is stopped or its endpoint has no resolved URL. The tab still exists.
  embeddedUrl: string | null;
  running: boolean;
};

// An app's own settings page, embedded from the app's origin. Shell renders the tab and the frame
// and knows nothing about what is inside — the objection that kept these pages out of Shell in the
// first place was Shell knowing an app's settings schema, not Shell hosting the page.
export function AppSettingsTabPanel({
  tab,
  theme,
  themePreference,
  onAuthRequired,
  resolveDelegatedTokenRequest,
  onOpenSettingsFrame,
  onStartApp,
}: {
  tab: AppSettingsTab;
  theme: HostyResolvedTheme;
  themePreference: HostyThemePreference;
  onAuthRequired?: (appId: string) => void;
  /**
   * Undefined for every app but the one that already qualifies (the assistant gateway).
   *
   * Settings surfaces authenticate the way every other embedded page does — the app's own Hosty
   * session — so hosting one grants no credential. The rule is not re-decided here: this passes
   * through whatever the existing one allows, so a new context cannot widen it by existing.
   */
  resolveDelegatedTokenRequest?: (appId: string) => ((refresh: boolean) => Promise<DelegatedTokenGrant>) | undefined;
  /**
   * Mints a launch code for this app and returns the URL to embed.
   *
   * Embedding Core's resolved endpoint URL directly is not enough: that frame carries no Hosty app
   * session, so an app authenticating the ordinary way loads unauthenticated and cannot recover —
   * `hosty:auth-required` recovery is scoped to the active workspace. The gateway hid this because
   * it authenticates with a delegated token instead.
   */
  onOpenSettingsFrame: (appId: string, path: string) => Promise<string>;
  onStartApp?: (appId: string) => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!tab.embeddedUrl) {
      setSrc(null);
      return;
    }

    // Ignored once the operator has moved to another tab: a launch code is a round trip, and the
    // answer to a tab nobody is looking at must not replace the one they are.
    let active = true;
    setSrc(null);
    setError(null);
    void onOpenSettingsFrame(tab.appId, tab.path)
      .then((launched) => {
        if (active) {
          setSrc(launched);
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(reason instanceof Error ? reason.message : "Could not open this app's settings.");
        }
      });

    return () => {
      active = false;
    };
  }, [onOpenSettingsFrame, tab.appId, tab.path, tab.embeddedUrl]);

  if (!tab.embeddedUrl) {
    return (
      <div className="flex min-h-64 items-center justify-center rounded-lg border bg-card">
        <div className="max-w-md px-6 py-10 text-center">
          <Settings2 className="mx-auto mb-3 h-6 w-6 text-muted-foreground" />
          <div className="font-medium">{tab.label} isn&apos;t running</div>
          <p className="mt-2 text-sm text-muted-foreground">
            Its settings are served by the app itself, so they are only reachable while it runs.
            Nothing here is lost — start the app and the page loads.
          </p>
          {onStartApp && !tab.running && (
            <Button variant="outline" size="sm" className="mt-4" onClick={() => onStartApp(tab.appId)}>
              <Play /> Start {tab.label}
            </Button>
          )}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-64 items-center justify-center rounded-lg border bg-card">
        <div className="max-w-md px-6 py-10 text-center">
          <Settings2 className="mx-auto mb-3 h-6 w-6 text-muted-foreground" />
          <div className="font-medium">{tab.label} settings could not be opened</div>
          <p className="mt-2 text-sm text-muted-foreground">{error}</p>
        </div>
      </div>
    );
  }

  if (!src) {
    return <div className="min-h-64 rounded-lg border bg-card" aria-busy="true" />;
  }

  return (
    <div className="relative h-[calc(100vh-16rem)] min-h-96 overflow-hidden rounded-lg border bg-background">
      <EmbeddedAppFrame
        src={src}
        title={`${tab.label} settings`}
        appId={tab.appId}
        theme={theme}
        themePreference={themePreference}
        onAuthRequired={onAuthRequired}
        onDelegatedTokenRequest={resolveDelegatedTokenRequest?.(tab.appId)}
      />
    </div>
  );
}
