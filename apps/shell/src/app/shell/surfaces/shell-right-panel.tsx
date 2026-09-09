"use client";

import { useState } from "react";
import { LoaderCircle, Play } from "lucide-react";
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
  onAskAssistant,
  attention,
  onAttention,
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
  onAskAssistant?: (text: string, sourceAppId: string) => void;
  /** appId → how many of its sessions want the operator. Rendered on the tab. */
  attention?: Record<string, number>;
  onAttention?: (appId: string, count: number) => void;
}) {
  // Readiness gates *opening* a tab, not the life of an open one. A key enters this set when its
  // service first reads ready — or when the operator opens it anyway — and stays: a frame already
  // on screen survives `healthy → degraded`, because a transient probe failure must not destroy what
  // the operator has typed. Only the lifecycle axis (embeddedUrl going null) unmounts it.
  const [openedKeys, setOpenedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const opened = activeTab !== null && (activeTab.readiness === "ready" || openedKeys.has(activeTab.key));
  // Adjust during render rather than in an effect (react.dev/learn/you-might-not-need-an-effect).
  if (activeTab && activeTab.readiness === "ready" && !openedKeys.has(activeTab.key)) {
    setOpenedKeys((current) => new Set(current).add(activeTab.key));
  }

  // No launch code is minted for a tab that is not open yet: `useAppSurfaceSrc` keys on the URL.
  const embedTab = activeTab && !opened ? { ...activeTab, embeddedUrl: null } : activeTab;
  const { src, error } = useAppSurfaceSrc(embedTab, onOpenSurfaceFrame, "Could not open this panel.", reloadKey);

  return (
    <aside className="flex h-full min-h-0 min-w-0 flex-col border-l bg-sidebar text-sidebar-foreground">
      <div className="flex items-center border-b px-2">
        <div className="flex min-w-0 flex-1 items-center gap-3 overflow-x-auto" role="tablist" aria-label="Panels">
          {tabs.map((tab) => {
            // Two separate questions. Whether the tab leads anywhere is answered by the URL alone —
            // the surface rule has already folded the runtime state into it, and an app can also be
            // running with no address resolved yet. Only the *wording* asks whether it is running,
            // so a tab never dims for one reason and explains itself with another.
            const unavailable = !tab.embeddedUrl;
            const reason = tab.transitioning ? tab.runtimeState : tab.running ? "not reachable" : "not running";

            return (
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
                unavailable && "opacity-60",
              )}
              title={unavailable ? `${tab.label} (${reason})` : tab.label}
            >
              {tab.label}
              {/* Not a visible marker — the strip carries the state as dimming, and a glyph tried
                  here read as decoration rather than as "stopped". Dimming reaches nobody using a
                  screen reader, though, and `title` on a button that already has text is announced
                  as its description at best, so the state is said outright for that reader alone. */}
              {unavailable && <span className="sr-only">, {reason}</span>}
              {(attention?.[tab.appId] ?? 0) > 0 && (
                <>
                  {/* On the tab, because the tab is on every page: a session that stops for a person
                      is only findable if the trigger says so from wherever the operator happens to be.
                      The dot is decoration; the words are what a screen reader reads, and an aria-label
                      on a non-interactive span would not reach the button's accessible name. */}
                  <span
                    className="ml-1.5 inline-flex size-1.5 rounded-full bg-amber-500 align-middle"
                    aria-hidden
                  />
                  <span className="sr-only">, {attention?.[tab.appId]} waiting for you</span>
                </>
              )}
            </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 bg-background">
        <RightPanelBody
          activeTab={activeTab}
          opened={opened}
          onOpenAnyway={() => activeTab && setOpenedKeys((current) => new Set(current).add(activeTab.key))}
          src={src}
          error={error}
          theme={theme}
          themePreference={themePreference}
          onAuthRequired={onAuthRequired}
          resolveDelegatedTokenRequest={resolveDelegatedTokenRequest}
          onStartApp={onStartApp}
          outbound={outbound}
          onAttention={onAttention}
          onAskAssistant={onAskAssistant}
        />
      </div>
    </aside>
  );
}

function RightPanelBody({
  activeTab,
  opened,
  onOpenAnyway,
  src,
  error,
  theme,
  themePreference,
  onAuthRequired,
  resolveDelegatedTokenRequest,
  onStartApp,
  onAttention,
  outbound,
  onAskAssistant,
}: {
  activeTab: AppSurfaceTab | null;
  /** Whether readiness has admitted this tab (or the operator overrode it). */
  opened: boolean;
  onOpenAnyway: () => void;
  src: string | null;
  error: string | null;
  theme: HostyResolvedTheme;
  themePreference: HostyThemePreference;
  onAuthRequired?: (appId: string) => void;
  resolveDelegatedTokenRequest?: (appId: string) => ((refresh: boolean) => Promise<DelegatedTokenGrant>) | undefined;
  onStartApp?: (appId: string) => void;
  onAttention?: (appId: string, count: number) => void;
  outbound?: { message: unknown; nonce: number } | null;
  onAskAssistant?: (text: string, sourceAppId: string) => void;
}) {
  if (!activeTab) {
    return null;
  }

  if (!activeTab.embeddedUrl) {
    // Three different facts, and only one of them is answered by starting the app. An app mid-verb is
    // reporting progress, not asking for anything: Core is already acting, and the panel settles on
    // its own when the app answers.
    if (activeTab.transitioning) {
      return (
        <PanelMessage title={`${activeTab.label} is ${activeTab.runtimeState}`}>
          <p className="flex items-center justify-center gap-2">
            <LoaderCircle className="h-4 w-4 animate-spin" /> This panel opens when the app answers.
          </p>
        </PanelMessage>
      );
    }

    // A running app with no resolved address is a different fact from a stopped one, and telling its
    // operator to start it would be advice for a state they are not in.
    return activeTab.running ? (
      <PanelMessage title={`${activeTab.label} is not reachable`}>
        <p>The app is running, but Hosty has no address for this panel yet.</p>
      </PanelMessage>
    ) : (
      <PanelMessage title={`${activeTab.label} isn't running`}>
        <p>This panel is served by the app itself, so it is only reachable while the app runs.</p>
        {onStartApp && (
          <Button variant="outline" size="sm" className="mt-4" onClick={() => onStartApp(activeTab.appId)}>
            <Play /> Start
          </Button>
        )}
      </PanelMessage>
    );
  }

  if (!opened) {
    // Reachable, but not confirmed to answer. `degraded` is offered rather than refused: an expired
    // budget proves nothing about the app, and the operator may know better.
    if (activeTab.readiness === "degraded") {
      return (
        <PanelMessage title={`${activeTab.label} is running, but its readiness is not confirmed yet`}>
          <p>Core could not confirm that this panel answers. It may still be coming up — or it may need a look.</p>
          <Button variant="outline" size="sm" className="mt-4" onClick={onOpenAnyway}>
            Open anyway
          </Button>
        </PanelMessage>
      );
    }

    return (
      <PanelMessage title={activeTab.readiness === "unobserved" ? `${activeTab.label} is waiting for its first health reading` : `${activeTab.label} is starting`}>
        <p className="flex items-center justify-center gap-2">
          <LoaderCircle className="h-4 w-4 animate-spin" /> This panel opens when the app answers.
        </p>
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
      onAskAssistant={onAskAssistant}
      onAttention={onAttention ? (count) => onAttention(activeTab.appId, count) : undefined}
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
