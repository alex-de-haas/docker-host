"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { HostyNextOverlay } from "@hosty-sdk/app/next";
import { appFetch } from "@hosty-sdk/app/browser-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
function SettingsForm() {
  const [source, setSource] = useState(""), [saved, setSaved] = useState<string | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => { let active = true; void appFetch("/api/settings").then(async response => {
    const value = await response.json(); if (!response.ok) throw new Error(value.message);
    if (active) { setSource(value.sourceUrl); setSaved(value.sourceUrl); }
  }).catch(cause => { if (active) setError(cause.message); }); return () => { active = false; }; }, []);
  return <main className="mx-auto flex max-w-2xl flex-col gap-6 p-6"><header className="flex items-center justify-between gap-3"><h1 className="text-xl font-semibold">Marketplace settings</h1><Button asChild variant="outline"><Link href="/">Catalog</Link></Button></header>
    <form className="flex flex-col gap-4" onSubmit={async event => { event.preventDefault(); setBusy(true); setError(""); try {
      const response = await appFetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceUrl: source, expectedSourceUrl: saved }) });
      const value = await response.json(); if (!response.ok) throw new Error(value.message); setSaved(value.sourceUrl); setSource(value.sourceUrl);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); } }}>
      <label className="flex flex-col gap-2 text-sm">Catalog source<Input type="url" required value={source} disabled={saved === null || busy} onChange={event => setSource(event.target.value)} /></label>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button className="self-start" disabled={saved === null || saved === source || busy}>{busy ? "Saving…" : "Save settings"}</Button>
    </form></main>;
}
export default function SettingsPage() { return <HostyNextOverlay><SettingsForm /></HostyNextOverlay>; }
