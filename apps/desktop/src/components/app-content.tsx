"use client";
import { HostyAppFrame } from "@hosty-sdk/app/ui/react";
import { FileText, LoaderCircle, Play, RotateCw, ShieldAlert, WifiOff } from "lucide-react";
import { appPages, pageReady, pageUrl, isBusy, type App, type Theme } from "@/lib/model";
import { AppIcon } from "./app-icon";

export function AppContent({ app, pageIndex, theme, preference, admin, pending, error, onPage, onStart, onRetry }: {
  app?: App; pageIndex: number; theme: "light" | "dark"; preference: Theme; admin: boolean; pending?: string;
  error?: string; onPage: (index: number) => void; onStart: () => void; onRetry: () => void;
}) {
  if (!app) return <div className="window-state"><ShieldAlert size={36} /><h2>Application unavailable</h2><p>Your access may have changed, or this application was removed.</p></div>;
  const pages = appPages(app), page = pages[Math.min(pageIndex, pages.length - 1)];
  const url = pageUrl(app, page), ready = pageReady(app, page);
  const waiting = Boolean(pending || isBusy(app) || app.runtimeState === "running" && !ready);
  const canStart = admin && app.runtimeState !== "running";
  const content = ready && url && !pending ? <HostyAppFrame key={`${app.installationId}:${url}`} title={app.displayName} src={url}
    surface={{ appId: app.id, installationId: app.installationId || "", endpoint: page.endpoint || app.entryEndpoint || "web",
      origin: new URL(url).origin, route: new URL(url).pathname + new URL(url).search + new URL(url).hash,
      framePolicy: app.framePolicy || { microphone: false, popupEscape: false } }}
    view={{ viewId: `desktop-${app.id}`, workspaceId: `desktop-${app.id}`, chrome: { navigation: "hide", tools: { enabled: true, launcher: "hide" } } }}
    theme={theme} themePreference={preference} className="app-frame" />
    : <div className="window-state">
      <AppIcon app={app} className="state-icon" />
      {waiting ? <LoaderCircle className="spin" size={24} /> : <WifiOff size={22} className="muted" />}
      <h2>{waiting ? `${pending === "stop" || app.runtimeState === "stopping" ? "Stopping" : "Starting"} ${app.displayName}…` : `${app.displayName} is unavailable`}</h2>
      <p>{error || app.lastError || (waiting ? "Your window will open when the application is ready." : canStart ? "Start this application to open it here." : app.runtimeState === "running" ? "This application has not published an available page yet." : "An administrator can start this application for you.")}</p>
      {!waiting && canStart && <button className="primary-button" onClick={onStart}><Play size={15} />Start application</button>}
      {!waiting && !canStart && <button className="subtle-button" onClick={onRetry}><RotateCw size={15} />Refresh</button>}
    </div>;
  return <div className="app-layout">
    {pages.length > 1 && <nav className="window-sidebar" aria-label={`${app.displayName} pages`}>
      <div className="sidebar-caption">{app.displayName}</div>
      {pages.map((item, index) => <button key={`${item.endpoint}:${item.path}`} className={index === pageIndex ? "selected" : ""} onClick={() => onPage(index)}><FileText size={17} /><span>{item.label}</span></button>)}
    </nav>}
    <div className="app-document">{content}</div>
  </div>;
}
