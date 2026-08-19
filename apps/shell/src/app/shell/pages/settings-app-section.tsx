"use client";

import { Play, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { HostyResolvedTheme, HostyThemePreference } from "../types";
import { EmbeddedAppFrame } from "../embedding/embedded-app-frame";
import type { DelegatedTokenGrant } from "../workspace/delegated-token-intent";
import type { AppSurfaceTab } from "../surfaces/app-surface-tabs";
import { useAppSurfaceSrc } from "../surfaces/use-app-surface-src";

// An app's own settings page, embedded from the app's origin. Shell renders the tab and the frame
// and knows nothing about what is inside — the objection that kept these pages out of Shell in the
// first place was Shell knowing an app's settings schema, not Shell hosting the page.
//
// The session mechanism is shared with the right panel rather than copied: a second copy of the
// launch-code round trip is a second chance to omit it, which is how the workspace-only gap happened.
export function AppSettingsTabPanel({
  tab,
  theme,
  themePreference,
  onAuthRequired,
  resolveDelegatedTokenRequest,
  onOpenSurfaceFrame,
  onStartApp,
  reloadKey,
}: {
  tab: AppSurfaceTab;
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
  onOpenSurfaceFrame: (appId: string, embeddedUrl: string) => Promise<string>;
  onStartApp?: (appId: string) => void;
  reloadKey?: number;
}) {
  const { src, error } = useAppSurfaceSrc(tab, onOpenSurfaceFrame, "Could not open this app's settings.", reloadKey);

  if (!tab.embeddedUrl) {
    return (
      <SettingsMessage title={`${tab.label} isn't running`}>
        <p className="mt-2 text-sm text-muted-foreground">
          Its settings are served by the app itself, so they are only reachable while it runs.
          Nothing here is lost — start the app and the page loads.
        </p>
        {onStartApp && !tab.running && (
          <Button variant="outline" size="sm" className="mt-4" onClick={() => onStartApp(tab.appId)}>
            <Play /> Start {tab.label}
          </Button>
        )}
      </SettingsMessage>
    );
  }

  if (error) {
    return (
      <SettingsMessage title={`${tab.label} settings could not be opened`}>
        <p className="mt-2 text-sm text-muted-foreground">{error}</p>
      </SettingsMessage>
    );
  }

  if (!src) {
    return <div className="min-h-64" aria-busy="true" />;
  }

  return (
    // No frame of its own: the tab strip above already bounds this region, and a border here drew a
    // second box around a page that is itself full of cards.
    // Sized against the strip and the page header above it, so the app's page gets the rest of the
    // window rather than a short box with the tab's background showing under it.
    <div className="relative h-[calc(100dvh-13rem)] min-h-96 overflow-hidden bg-background">
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

function SettingsMessage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-64 items-center justify-center rounded-lg border bg-card">
      <div className="max-w-md px-6 py-10 text-center">
        <Settings2 className="mx-auto mb-3 h-6 w-6 text-muted-foreground" />
        <div className="font-medium">{title}</div>
        {children}
      </div>
    </div>
  );
}
