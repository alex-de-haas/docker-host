"use client";
import { useState } from "react";
import { AppWindow, type LucideIcon } from "lucide-react";
import { DynamicIcon, iconNames } from "lucide-react/dynamic";
import type { App } from "@/lib/model";
const normalized = new Map(iconNames.map(name => [name.replace(/[-_\s]/g, "").toLowerCase(), name]));
export function AppIcon({ app, icon: Icon, className = "", tone = 0 }: { app?: App; icon?: LucideIcon; className?: string; tone?: number }) {
  const src = app?.iconUrl?.startsWith("/api/apps/") ? `/api/core${app.iconUrl}`
    : /^https?:\/\//.test(app?.iconUrl || "") ? app?.iconUrl : null;
  const [failed, setFailed] = useState<string | null>(null);
  const name = app?.icon ? normalized.get(app.icon.replace(/[-_\s]/g, "").toLowerCase()) : null;
  const Fallback = Icon || AppWindow;
  const color = app ? [...app.id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 6 : tone;
  return <span className={`app-icon tone-${color} ${className}`} aria-hidden="true">
    {/* Authenticated per-installation assets must load through the browser session, not an image optimization server. */}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    {src && failed !== src ? <img src={src} alt="" draggable={false} onError={() => setFailed(src)} />
      : name ? <DynamicIcon name={name} fallback={() => <Fallback />} /> : <Fallback />}
  </span>;
}
