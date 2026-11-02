"use client";
import { useState } from "react";
import { AppWindow, FileText, type LucideIcon } from "lucide-react";
import { DynamicIcon, iconNames } from "lucide-react/dynamic";
import type { App } from "@/lib/model";
const normalized = new Map(iconNames.map(name => [name.replace(/[-_\s]/g, "").toLowerCase(), name]));
function assetUrl(url?: string | null) {
  return url?.startsWith("/api/apps/") ? `/api/core${url}` : /^https?:\/\//.test(url || "") ? url : null;
}

export function PageIcon({ src }: { src?: string | null }) {
  const url = assetUrl(src);
  const [failed, setFailed] = useState<string | null>(null);
  // Use the authenticated Core proxy for manifest navigation assets, just like app icons.
  // eslint-disable-next-line @next/next/no-img-element
  return url && failed !== url ? <img className="page-icon" src={url} alt="" aria-hidden="true" draggable={false} onError={() => setFailed(url)} /> : <FileText size={17} aria-hidden="true" />;
}

export function AppIcon({ app, icon: Icon, className = "", tone = 0 }: { app?: App; icon?: LucideIcon; className?: string; tone?: number }) {
  const src = assetUrl(app?.iconUrl);
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
