"use client";
import { HostyAppFrame } from "@hosty-sdk/app/ui/react";
import { LoaderCircle, Play, RotateCw, ShieldAlert, WifiOff } from "lucide-react";
import { appPages, pageReady, pageUrl, isBusy, type App, type Theme, type WindowDestination } from "@/lib/model";
import { destinationPage } from "@/lib/windows";
import { windowWorkspace } from "@/lib/window-tools";
import { AppIcon, PageIcon } from "./app-icon";

export function AppContent({ app, windowId, destination, installationId, onSurfaceState, pageIndex, navigationCompact = false, theme, preference, admin, pending, error, onPage, onStart, onRetry }: {
  app?: App; windowId: string; destination?: WindowDestination; installationId?: string;
  onSurfaceState?: (state: { route: string; title?: string; endpoint: string }) => void; pageIndex: number; navigationCompact?: boolean; theme: "light" | "dark"; preference: Theme; admin: boolean; pending?: string;
  error?: string; onPage: (index: number) => void; onStart: () => void; onRetry: () => void;
}) {
  if (!app) return <div className="window-state"><ShieldAlert size={36} /><h2>Application unavailable</h2><p>Your access may have changed, or this application was removed.</p></div>;
  const pages = appPages(app);
  const target = destination && destinationPage(app, destination, installationId);
  const selectedIndex = target ? target.index : Math.min(pageIndex, pages.length - 1);
  const page = pages[selectedIndex];
  const url = target?.url ?? pageUrl(app, page), ready = pageReady(app, page);
  const waiting = Boolean(pending || isBusy(app) || app.runtimeState === "running" && !ready);
  const canStart = admin && app.runtimeState !== "running";
  const content = ready && url && !pending ? <HostyAppFrame key={`${app.installationId}:${url}`} title={app.displayName} src={url}
    surface={{ appId: app.id, installationId: app.installationId || "", endpoint: page.endpoint || app.entryEndpoint || "web",
      origin: new URL(url).origin, route: new URL(url).pathname + new URL(url).search + new URL(url).hash,
      framePolicy: app.framePolicy || { microphone: false, popupEscape: false } }}
    view={{ viewId: windowWorkspace(windowId), workspaceId: windowWorkspace(windowId),
      onSurfaceState: state => onSurfaceState?.({ ...state, endpoint: page.endpoint || app.entryEndpoint || "web" }), chrome: { navigation: "hide", tools: { enabled: true, launcher: "hide" } } }}
    theme={theme} themePreference={preference} className="app-frame" />
    : <div className="window-state">
      <AppIcon app={app} className="state-icon" />
      {waiting ? <LoaderCircle className="spin" size={24} /> : <WifiOff size={22} className="muted" />}
      <h2>{waiting ? `${pending === "stop" || app.runtimeState === "stopping" ? "Stopping" : "Starting"} ${app.displayName}…` : `${app.displayName} is unavailable`}</h2>
      <p>{error || app.lastError || (waiting ? "Your window will open when the application is ready." : canStart ? "Start this application to open it here." : app.runtimeState === "running" ? "This application has not published an available page yet." : "An administrator can start this application for you.")}</p>
      {!waiting && canStart && <button className="primary-button" onClick={onStart}><Play size={15} />Start application</button>}
      {!waiting && !canStart && <button className="subtle-button" onClick={onRetry}><RotateCw size={15} />Refresh</button>}
    </div>;
  return <div className="app-layout" data-navigation={navigationCompact ? "compact" : "expanded"}>
    {pages.length > 1 && <nav id={`pages-${windowId}`} className="window-sidebar" aria-label={`${app.displayName} pages`}>
      {pages.map((item, index) => <button key={`${item.endpoint}:${item.path}`} className={index === selectedIndex ? "selected" : ""} aria-label={item.label} title={item.label} aria-current={index === selectedIndex ? "page" : undefined} onClick={() => onPage(index)}><PageIcon src={item.iconUrl} /><span>{item.label}</span></button>)}
    </nav>}
    <div className="app-document">{content}</div>
  </div>;
}
