"use client";

import { useId, useRef, useState } from "react";
import { LoaderCircle, PanelsTopLeft, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { AppIcon } from "../app-icon";
import { panelFocusIndex } from "./panel-rail-state";
import { cn } from "@/lib/utils";
import type { HostyResolvedTheme, HostyThemePreference } from "../types";
import { EmbeddedAppFrame } from "../embedding/embedded-app-frame";
import type { DelegatedTokenGrant } from "../workspace/delegated-token-intent";
import type { AppSurfaceTab } from "./app-surface-tabs";
import { useAppSurfaceSrc } from "./use-app-surface-src";

export function ShellRightPanel({
  tabs,
  expanded,
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
  expanded: boolean;
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
  const bodyId = useId();
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const focusKey = tabs.some((tab) => tab.key === focusedKey) ? focusedKey : activeTab?.key ?? tabs[0]?.key;
  // The rail alone must not launch an app. Once activated, retain only the selected body
  // across collapse; switching still uses the existing single-frame lifecycle.
  const [activatedKey, setActivatedKey] = useState<string | null>(null);
  const bodyActivated = activeTab !== null && (expanded || activatedKey === activeTab.key);
  if (expanded && activeTab && activatedKey !== activeTab.key) setActivatedKey(activeTab.key);
  if (!expanded && activatedKey !== null && activatedKey !== activeTab?.key) setActivatedKey(null);

  // Readiness gates *opening* a tab, not the life of an open one. A key enters this set when its
  // service first reads ready — or when the operator opens it anyway — and stays: a frame already
  // on screen survives `healthy → degraded`, because a transient probe failure must not destroy what
  // the operator has typed. Only the lifecycle axis (embeddedUrl going null) unmounts it.
  const [openedKeys, setOpenedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const opened = bodyActivated && activeTab !== null && (activeTab.readiness === "ready" || openedKeys.has(activeTab.key));
  // Adjust during render rather than in an effect (react.dev/learn/you-might-not-need-an-effect).
  if (bodyActivated && activeTab && activeTab.readiness === "ready" && !openedKeys.has(activeTab.key)) {
    setOpenedKeys((current) => new Set(current).add(activeTab.key));
  }

  // No launch code is minted for a tab that is not open yet: `useAppSurfaceSrc` keys on the URL.
  const embedTab = !bodyActivated ? null : activeTab && !opened ? { ...activeTab, embeddedUrl: null } : activeTab;
  const { src, error } = useAppSurfaceSrc(embedTab, onOpenSurfaceFrame, "Could not open this panel.", reloadKey);

  return (
    <aside className="flex h-full min-h-0 min-w-0 text-foreground" aria-label="App panels">
      <section id={bodyId} hidden={!expanded} inert={!expanded} aria-label={activeTab?.label}
        className={cn("min-h-0 min-w-0 flex-1 flex-col bg-background", expanded ? "flex" : "hidden")}>
        <div className="min-h-0 flex-1">
        <RightPanelBody
          activeTab={bodyActivated ? activeTab : null}
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
      </section>
      <TooltipProvider delayDuration={350}>
        <div role="toolbar" aria-label="Panels" aria-orientation="vertical"
          className={cn("flex w-12 max-w-full shrink-0 flex-col items-center gap-1 overflow-y-auto overflow-x-hidden bg-background py-2", expanded && "border-l")}>
          {tabs.map((tab, index) => {
            const selected = expanded && tab.key === activeTab?.key;
            const unavailable = !tab.embeddedUrl;
            const reason = tab.transitioning ? tab.runtimeState : tab.running ? "not reachable" : "not running";
            const waiting = attention?.[tab.appId] ?? 0;
            const description = `${tab.appLabel || tab.appId} · ${tab.label}${unavailable ? ` (${reason})` : ""}${waiting > 0 ? ` · ${waiting} waiting for you` : ""}`;
            return (
              <Tooltip key={tab.key}>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" type="button"
                    ref={(element) => { if (element) buttons.current.set(tab.key, element); else buttons.current.delete(tab.key); }}
                    tabIndex={tab.key === focusKey ? 0 : -1}
                    aria-label={`${selected ? "Hide" : "Open"} ${description}`}
                    aria-pressed={selected} aria-controls={bodyId}
                    onFocus={() => setFocusedKey(tab.key)}
                    onKeyDown={(event) => {
                      const next = panelFocusIndex(event.key, index, tabs.length);
                      if (next === null) return;
                      event.preventDefault();
                      buttons.current.get(tabs[next].key)?.focus();
                    }}
                    onClick={() => onSelectTab(tab.key)}
                    className={cn("relative size-9 shrink-0 rounded-lg text-muted-foreground hover:text-foreground",
                      selected && "bg-muted text-foreground shadow-xs ring-1 ring-border",
                      unavailable && "opacity-60")}>
                    <AppIcon src={null} name={tab.icon} fallback={PanelsTopLeft} className="size-5" />
                    {waiting > 0 && <span aria-hidden className="absolute right-1 top-1 size-1.5 rounded-full bg-amber-500" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="left" sideOffset={10}>{description}</TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      </TooltipProvider>
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
      <PanelMessage title={`${activeTab.label} is starting`}>
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
      grantedCorePermissions={activeTab.grantedCorePermissions}
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
