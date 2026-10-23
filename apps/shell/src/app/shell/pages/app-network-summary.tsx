"use client";

import { Globe, Network } from "lucide-react";
import { toast } from "@/components/reui/operation-toast";
import { Badge } from "@/components/ui/badge";
import { getEndpointPublicOrigin, getEndpointService } from "../app-helpers";
import type { CoreApp } from "../types";
import { EndpointUrlBlock } from "./endpoint-url-block";
import { EndpointAvailabilityMarker, PortReassignControl } from "./port-reassign-control";
import { PublicOriginControl } from "./public-origin-control";

export function AppNetworkSummary({ app }: { app: CoreApp }) {
  const copy = async (url: string) => {
    try { await navigator.clipboard.writeText(url); toast.success("Address copied"); }
    catch { toast.error("Could not copy address", { description: "Select and copy the address manually." }); }
  };
  return <div className="space-y-4">
    {(app.endpoints ?? []).map(endpoint => {
      const publicOrigin = getEndpointPublicOrigin(app, endpoint);
      return <section key={endpoint.key} className="overflow-hidden rounded-xl border bg-card" aria-label={`Endpoint ${endpoint.key}`}>
        <header className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/25 px-4 py-3"><div className="flex min-w-0 items-center gap-2"><Network className="size-4 shrink-0 text-muted-foreground" aria-hidden /><h3 className="break-all font-mono text-sm font-medium">{endpoint.key}</h3><EndpointAvailabilityMarker availability={endpoint.availability} /></div><Badge variant="outline">{endpoint.protocol}</Badge></header>
        <div className="divide-y">
          <div className="grid min-w-0 gap-2 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]"><div><p className="text-sm font-medium">Service address</p><p className="mt-1 break-all text-xs text-muted-foreground">{getEndpointService(endpoint)}</p></div><EndpointUrlBlock url={endpoint.url} missingText="Not assigned" copyTitle="Copy service address" openTitle="Open service address" onCopy={copy} actions={<PortReassignControl app={app} endpoint={endpoint} />} /></div>
          {endpoint.public ? <div className="grid min-w-0 gap-2 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]"><div><p className="flex items-center gap-1.5 text-sm font-medium"><Globe className="size-3.5 text-muted-foreground" aria-hidden />Browser address</p><p className="mt-1 text-xs text-muted-foreground">{endpoint.localOrigin && !publicOrigin ? "Local · this computer only" : "Configured origin"}</p></div><EndpointUrlBlock url={endpoint.browserOrigin ?? publicOrigin} missingText="Not configured" copyTitle="Copy browser address" openTitle="Open browser address" onCopy={copy} actions={<PublicOriginControl app={app} endpoint={endpoint} />} /></div>
            : <p className="px-4 py-3 text-xs text-muted-foreground">Internal endpoint. This app does not declare a browser address for it.</p>}
        </div>
      </section>;
    })}
  </div>;
}
