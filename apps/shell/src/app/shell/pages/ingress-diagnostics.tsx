"use client";

import { useCallback, useEffect, useState } from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isAuthRequiredRedirectError } from "../core-api";
import { useShellActions } from "../shell-context";
import type { CloudflareDiagnostics, CloudflareDiagnosticState } from "../types";
import { InlineError } from "../ui";

// What each drift verdict means and what to do about it. "ok" is filtered out before rendering, but it is
// listed so the map stays total: a state Core adds later must fail the build here rather than render as a
// blank line next to a hostname.
const DIAGNOSTIC_TEXT: Record<CloudflareDiagnosticState, string> = {
  ok: "",
  app_missing: "the app is gone, so this address is an orphan — unpublish it or remove it in Cloudflare",
  route_missing: "the tunnel has no route for it, so the address resolves to nothing — publish it again",
  dns_missing: "its DNS record is gone — publish it again to recreate it",
  dns_foreign: "its DNS record points somewhere other than this tunnel — something else answers for it",
  unknown: "it could not be checked just now",
};

// Whether what Hosty published still matches what Cloudflare serves, and which public endpoints have no
// address at all. Read-only and on demand: nothing here reconciles, because a background writer would
// fight the operator's own dashboard changes.
export function IngressDiagnostics() {
  const { coreOrigin, sendCsrfJson } = useShellActions();
  const [diagnostics, setDiagnostics] = useState<CloudflareDiagnostics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await sendCsrfJson(`${coreOrigin}/api/core/cloudflare/diagnostics`, undefined, "GET");
      setDiagnostics((await response.json()) as CloudflareDiagnostics);
      setError(null);
    } catch (loadError) {
      if (!isAuthRequiredRedirectError(loadError)) {
        setError(loadError instanceof Error ? loadError.message : "Could not check the published addresses.");
      }
    } finally {
      setLoading(false);
    }
  }, [coreOrigin, sendCsrfJson]);

  useEffect(() => {
    void load();
  }, [load]);

  const drifted = (diagnostics?.publications ?? []).filter((publication) => publication.state !== "ok");
  const unpublished = diagnostics?.unpublishedEndpoints ?? [];
  const publicationCount = diagnostics?.publications.length ?? 0;

  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium">Checks</h3>
          <p className="text-xs text-muted-foreground">
            Whether the addresses Hosty published still match what Cloudflare serves, and which public endpoints
            have no address at all.
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" disabled={loading} onClick={() => void load()}>
          {loading ? <LoaderCircle className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
          Check again
        </Button>
      </div>

      {error && <InlineError message={error} />}

      {diagnostics && (
        <div className="space-y-2 text-xs">
          {drifted.length > 0 ? (
            <div className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-amber-700 dark:text-amber-400">
              <p className="font-medium">Published addresses that no longer match Cloudflare</p>
              <ul className="space-y-0.5">
                {drifted.map((publication) => (
                  <li key={`${publication.appId}:${publication.endpointKey}`}>
                    <span className="font-mono">{publication.hostname}</span> — {DIAGNOSTIC_TEXT[publication.state]}
                  </li>
                ))}
              </ul>
            </div>
          ) : diagnostics.checked && publicationCount > 0 ? (
            <p className="text-muted-foreground">
              All {publicationCount} published address{publicationCount === 1 ? "" : "es"} match what Cloudflare serves.
            </p>
          ) : diagnostics.checked ? (
            <p className="text-muted-foreground">Nothing is published yet.</p>
          ) : (
            <p className="text-muted-foreground">
              Published addresses cannot be checked until Cloudflare is the selected provider and connected.
            </p>
          )}

          {unpublished.length > 0 && (
            <div className="space-y-1 rounded-md border p-3">
              <p className="font-medium">Public endpoints with no address</p>
              <p className="text-muted-foreground">
                These are declared reachable from the internet and are currently reachable from nowhere.
              </p>
              <ul className="space-y-0.5 text-muted-foreground">
                {unpublished.map((endpoint) => (
                  <li key={`${endpoint.appId}:${endpoint.endpointKey}`}>
                    <span className="text-foreground">{endpoint.displayName}</span> · {endpoint.endpointKey}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
