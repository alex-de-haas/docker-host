"use client";

import type { ReactNode } from "react";
import { Copy, ExternalLink, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { IconButton } from "../ui";

export function EndpointUrlBlock({
  url,
  missingText,
  copyTitle,
  openTitle,
  configureTitle,
  onCopy,
  onConfigure,
  actions,
}: {
  url?: string | null;
  missingText: string;
  copyTitle: string;
  // Omit to render no Open affordance. An address is not automatically something to visit: Core's
  // own origin serves an API and its auth pages, so a browser tab on it answers nothing an operator
  // asked for — the URL is there to be read and copied.
  openTitle?: string;
  configureTitle?: string;
  onCopy: (url: string) => void | Promise<void>;
  // Rendered independently of `url`: an origin that is already set still needs an edit affordance, not
  // just a way to fill an empty one.
  onConfigure?: () => void;
  // Endpoint-scoped controls (port reassignment on the local URL, Cloudflare publishing on the public
  // origin) rendered beside copy/open so they sit with the URL they act on. Deliberately independent of
  // `url`: an unassigned port — or an origin not published yet — is exactly when they matter most.
  actions?: ReactNode;
}) {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md border bg-background px-2 py-1.5">
      <span className={cn("truncate font-mono", url ? "text-foreground" : "text-muted-foreground")}>{url || missingText}</span>
      <span className="flex items-center gap-1">
        {url && (
          <>
            <IconButton title={copyTitle} onClick={() => void onCopy(url)}>
              <Copy className="h-4 w-4" />
            </IconButton>
            {openTitle && (
              <Button type="button" variant="ghost" size="icon-sm" title={openTitle} aria-label={openTitle} asChild>
                <a href={url} target="_blank" rel="noreferrer">
                  <ExternalLink className="h-4 w-4" />
                </a>
              </Button>
            )}
          </>
        )}
        {onConfigure && (
          <IconButton title={configureTitle || "Configure"} onClick={onConfigure}>
            <Settings className="h-4 w-4" />
          </IconButton>
        )}
        {actions}
      </span>
    </div>
  );
}
