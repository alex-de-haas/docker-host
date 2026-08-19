"use client";

import { Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { HostyResolvedTheme, HostyThemePreference } from "../types";
import { EmbeddedAppFrame } from "../embedding/embedded-app-frame";
import type { DelegatedTokenGrant } from "../workspace/delegated-token-intent";
import type { AppSurfaceTab } from "./app-surface-tabs";
import { useAppSurfaceSrc } from "./use-app-surface-src";

// Shell's right rail: tools that stay at hand while the workspace keeps the screen.
//
// The property that motivated it is **docking**. An overlay pinned to the right edge has to be
// closed to read the page underneath, which is the root cause of the lost-draft report in
// agent-background-sessions: the operator closed the assistant to copy the error they were asking
// about. Docked, the error and the tool are legible at once.
//
// Shell owns the rail and nothing inside it. Each tab is an iframe from its app's own origin, so an
// app ships an always-at-hand tool without Shell learning that tool's UI.

export function ShellRightPanel({
  tabs,
  activeTab,
  theme,
  themePreference,
  onSelectTab,
  onAuthRequired,
  resolveDelegatedTokenRequest,
  onOpenSurfaceFrame,
  onStartApp,
  reloadKey,
  outbound,
}: {
  tabs: AppSurfaceTab[];
  activeTab: AppSurfaceTab | null;
  theme: HostyResolvedTheme;
  themePreference: HostyThemePreference;
  onSelectTab: (key: string) => void;
  /** Re-mints this panel's own launch code; a panel is not tied to the workspace and cannot borrow its recovery. */
  onAuthRequired?: (appId: string) => void;
  /**
   * Undefined for every app but the one that already qualifies.
   *
   * A panel surface authenticates the way every other embedded page does — the app's own Hosty
   * session — so holding one grants no credential. This passes through the existing rule rather
   * than restating it, so a new embedding context cannot widen that grant by existing.
   */
  resolveDelegatedTokenRequest?: (appId: string) => ((refresh: boolean) => Promise<DelegatedTokenGrant>) | undefined;
  onOpenSurfaceFrame: (appId: string, embeddedUrl: string) => Promise<string>;
  /** Undefined for a user who cannot start apps — Core refuses them, so the button would only fail. */
  onStartApp?: (appId: string) => void;
  reloadKey?: number;
  /** Handed to the active tab's frame; see EmbeddedAppFrame's `outbound`. */
  outbound?: { message: unknown; nonce: number } | null;
}) {
  const { src, error } = useAppSurfaceSrc(activeTab, onOpenSurfaceFrame, "Could not open this panel.", reloadKey);

  return (
    <aside className="flex h-full min-h-0 min-w-0 flex-col border-l bg-sidebar text-sidebar-foreground">
      <div className="flex items-center border-b px-2">
        <div className="flex min-w-0 flex-1 items-center gap-3 overflow-x-auto" role="tablist" aria-label="Panels">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={tab.key === activeTab?.key}
              onClick={() => onSelectTab(tab.key)}
              className={cn(
                // The same underline treatment as the Settings page's tabs: one shape for "these are
                // tabs" across Shell, rather than a second invention in the rail.
                "-mb-px shrink-0 border-b-2 py-2 text-xs transition-colors",
                tab.key === activeTab?.key
                  ? "border-foreground font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
                // A stopped app keeps its tab rather than vanishing — dimmed, so the strip shows the
                // tool exists and is merely not running.
                !tab.running && "opacity-60",
              )}
              title={tab.running ? tab.label : `${tab.label} (not running)`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 bg-background">
        <RightPanelBody
          activeTab={activeTab}
          src={src}
          error={error}
          theme={theme}
          themePreference={themePreference}
          onAuthRequired={onAuthRequired}
          resolveDelegatedTokenRequest={resolveDelegatedTokenRequest}
          onStartApp={onStartApp}
          outbound={outbound}
        />
      </div>
    </aside>
  );
}

function RightPanelBody({
  activeTab,
  src,
  error,
  theme,
  themePreference,
  onAuthRequired,
  resolveDelegatedTokenRequest,
  onStartApp,
  outbound,
}: {
  activeTab: AppSurfaceTab | null;
  src: string | null;
  error: string | null;
  theme: HostyResolvedTheme;
  themePreference: HostyThemePreference;
  onAuthRequired?: (appId: string) => void;
  resolveDelegatedTokenRequest?: (appId: string) => ((refresh: boolean) => Promise<DelegatedTokenGrant>) | undefined;
  onStartApp?: (appId: string) => void;
  outbound?: { message: unknown; nonce: number } | null;
}) {
  if (!activeTab) {
    return null;
  }

  if (!activeTab.embeddedUrl) {
    return (
      <PanelMessage title={`${activeTab.label} isn't running`}>
        <p>This panel is served by the app itself, so it is only reachable while the app runs.</p>
        {onStartApp && !activeTab.running && (
          <Button variant="outline" size="sm" className="mt-4" onClick={() => onStartApp(activeTab.appId)}>
            <Play /> Start
          </Button>
        )}
      </PanelMessage>
    );
  }

  if (error) {
    return <PanelMessage title={`${activeTab.label} could not be opened`}><p>{error}</p></PanelMessage>;
  }

  if (!src) {
    return <div className="h-full" aria-busy="true" />;
  }

  return (
    <EmbeddedAppFrame
      src={src}
      title={activeTab.label}
      appId={activeTab.appId}
      theme={theme}
      themePreference={themePreference}
      onAuthRequired={onAuthRequired}
      onDelegatedTokenRequest={resolveDelegatedTokenRequest?.(activeTab.appId)}
      outbound={outbound}
    />
  );
}

function PanelMessage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center">
      <div className="max-w-xs text-sm">
        <div className="font-medium">{title}</div>
        <div className="mt-2 text-muted-foreground">{children}</div>
      </div>
    </div>
  );
}
