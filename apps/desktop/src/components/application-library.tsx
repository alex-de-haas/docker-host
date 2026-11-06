"use client";
import { useState } from "react";
import { Search, ArrowUpRight } from "lucide-react";
import type { App } from "@/lib/model";
import { AppIcon } from "./app-icon";
export function ApplicationLibrary({ apps, admin, onOpen, onContext }: {
  apps: App[]; admin: boolean; onOpen: (app: App) => void; onContext: (app: App, x: number, y: number) => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = apps.filter(app => `${app.displayName} ${app.description || ""}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="application-library">
    <div className="library-heading"><div><span className="section-eyebrow">YOUR SPACE</span><h1>Applications</h1></div><span className="library-count">{apps.length} available</span></div>
    <label className="search-field"><Search size={18} /><input placeholder="Find an application…" aria-label="Search applications" value={query} onChange={event => setQuery(event.target.value)} /><kbd>Search</kbd></label>
    {filtered.length ? <div className="application-grid">{filtered.map(app => <button key={app.id} className="application-tile" onClick={() => onOpen(app)}
      onContextMenu={event => { event.preventDefault(); onContext(app, event.clientX, event.clientY); }}>
      <AppIcon app={app} /><strong>{app.displayName.replace(/^Hosty /, "")}</strong>
      <span>{admin && app.runtimeState !== "running" ? app.runtimeState === "stopped" ? "Click to start" : app.runtimeState : "Open application"}<ArrowUpRight size={11} /></span>
    </button>)}</div> : <div className="library-empty"><Search size={28} /><h2>{query ? "No matching applications" : "Your apps will appear here"}</h2>
      <p>{query ? "Try a different name." : "Applications appear when they are running and available to your account."}</p></div>}
  </div>;
}
