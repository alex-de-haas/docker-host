"use client";

import { Frame, FrameHeader, FramePanel } from "@/components/reui/frame";
import { toast } from "@/components/reui/operation-toast";
import { copyTextToClipboard } from "../clipboard";
import { ingressProviderLabel } from "../ingress";
import type { CoreStatus } from "../types";
import { EndpointUrlBlock } from "./endpoint-url-block";

/** Factual launch information from Shell's existing status snapshot, separate from editable settings. */
export function CoreHostInformation({ status }: { status?: CoreStatus | null }) {
  const copyUrl = async (url: string) => {
    try {
      await copyTextToClipboard(url);
      toast.success("URL copied", { description: url });
    } catch {
      toast.error("Copy failed", { description: "Clipboard access is unavailable." });
    }
  };
  const ingress = status?.ingressProvider?.trim()
    ? ingressProviderLabel(status.ingressProvider) : "Unavailable";
  return <section aria-labelledby="core-host-information">
    <Frame>
      <FrameHeader><h2 id="core-host-information" className="text-sm font-medium">Core information</h2></FrameHeader>
      <FramePanel className="space-y-4">
        <div className="grid gap-3 lg:grid-cols-2">
          <div className="min-w-0 space-y-1">
            <p className="text-xs text-muted-foreground">Listen address</p>
            <EndpointUrlBlock url={status?.listenUrl} missingText="Unavailable" copyTitle="Copy listen address" onCopy={copyUrl} />
          </div>
          <div className="min-w-0 space-y-1">
            <p className="text-xs text-muted-foreground">Public origin</p>
            <EndpointUrlBlock url={status?.corePublicOrigin} missingText={status ? "Not configured" : "Unavailable"} copyTitle="Copy browser address" onCopy={copyUrl} />
          </div>
        </div>
        <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="min-w-0"><dt className="text-xs text-muted-foreground">Data root</dt><dd className="mt-1 break-all font-mono text-xs">{status?.dataRoot || "Unavailable"}</dd></div>
          <div className="min-w-0"><dt className="text-xs text-muted-foreground">Runtime host</dt><dd className="mt-1 break-all font-mono text-xs">{status?.runtimePublicHost || "Unavailable"}</dd></div>
          <div className="min-w-0"><dt className="text-xs text-muted-foreground">Ingress</dt><dd className="mt-1 break-words text-sm">{ingress}</dd></div>
        </dl>
      </FramePanel>
    </Frame>
  </section>;
}
