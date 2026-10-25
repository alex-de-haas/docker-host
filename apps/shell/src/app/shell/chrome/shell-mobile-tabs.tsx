"use client";
import { useState, useSyncExternalStore } from "react";
import { LayoutDashboard, Grid2X2, PanelsTopLeft, Settings } from "lucide-react";
import { useHostyUiHost, useHostyChrome } from "@hosty-sdk/app/ui/react";
import type { UiHostSnapshot } from "@hosty-sdk/app/ui/host";
import { Button } from "@/components/ui/button";
import { useToolActivity, ToolsActivityBadge } from "./tool-activity";
import { cn } from "@/lib/utils";
const empty: UiHostSnapshot = { bootstrap: null, catalog: [], tools: [], selected: null, expanded: false, width: 360, error: null };
const noop = () => () => {};
export function ShellMobileTabs({ active, canManage, onNavigate, onOpenApps }: { active: string; canManage: boolean; onNavigate: (view: "dashboard" | "settings") => void; onOpenApps: () => void }) {
  const host = useHostyUiHost(), chrome = useHostyChrome();
  const snapshot = useSyncExternalStore(host?.subscribeSnapshot ?? noop, host?.getSnapshot ?? (() => empty), () => empty);
  const slot = snapshot.workspaces?.find(w => w.workspaceId === "default");
  const selected = snapshot.tools.find(t => t.presentationId === slot?.selectedId);
  const activity = useToolActivity();
  const [error, setError] = useState<string | null>(null);
  const tools = chrome.tools.enabled && chrome.tools.launcher !== "hide";
  return <nav aria-label="Phone navigation" className="shell-mobile-tabs">
    {error && <div role="alert" className="absolute bottom-full inset-x-0 border bg-background p-2 text-sm">{error}<Button size="sm" variant="ghost" onClick={() => setError(null)}>Dismiss</Button></div>}
    {canManage && <Button variant="ghost" aria-current={active === "dashboard" ? "page" : undefined} onClick={() => onNavigate("dashboard")}><LayoutDashboard /><span>Dashboard</span></Button>}
    <Button variant="ghost" aria-current={active === "workspace" ? "page" : undefined} onClick={() => { host?.collapseWorkspace("default"); onOpenApps(); }}><Grid2X2 /><span>Apps</span></Button>
    {tools && <Button variant="ghost" aria-label="Tools" aria-pressed={!!slot?.expanded} className={cn(slot?.expanded && "bg-brand-soft")} onClick={() => {
      setError(null);
      if (slot?.expanded) host?.collapseWorkspace("default");
      else if (selected) host?.focusPresentation(selected.presentationId);
      else void host?.openToolPicker({ requestId: crypto.randomUUID() }).then(result => { if (result.status !== "accepted") setError("Tools could not be opened. Try again."); });
    }}><PanelsTopLeft /><span>Tools<ToolsActivityBadge values={snapshot.catalog.map(activity.read)} /></span></Button>}
    <Button variant="ghost" aria-current={active === "settings" ? "page" : undefined} onClick={() => onNavigate("settings")}><Settings /><span>Settings</span></Button>
  </nav>;
}
