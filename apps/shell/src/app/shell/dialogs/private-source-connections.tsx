"use client";
import { useState } from "react";
import { InstallDialog } from "@hosty-sdk/app/install/react";
import type { InstallationClient, InstallationSource } from "@hosty-sdk/app/install";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { SourceToolsLink } from "../source/source-changes";
type Send = (url: string, body?: unknown, method?: string) => Promise<Response>;

export function SourceInstallDialog({ client, source, onClose, onInstalled }: {
  client: InstallationClient; source?: InstallationSource; coreOrigin: string; sendCsrfJson: Send;
  onClose: () => void; onInstalled: () => void;
}) {
  const [manifest, setManifest] = useState(source?.manifestPath ?? "");
  const [reviewing, setReviewing] = useState(false);
  if (reviewing) return <InstallDialog client={client}
    source={{ ...source, manifestPath: manifest.trim() }} onClose={() => setReviewing(false)} onInstalled={onInstalled} />;
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent>
    <DialogHeader><DialogTitle>Install app</DialogTitle></DialogHeader>
    <form className="space-y-4" onSubmit={event => { event.preventDefault(); setReviewing(true); }}>
      <label className="block space-y-1 text-sm">Manifest path or URL<Input required value={manifest} onChange={event => setManifest(event.target.value)} /></label>
      <SourceToolsLink context="private source connections" />
      <DialogFooter><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button disabled={!manifest.trim()}>Review installation</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>;
}

export function PrivateSourceConnections({ appId }: { appId: string }) {
  return <section className="border-t p-4"><SourceToolsLink context={`source connections for ${appId}`} /></section>;
}
