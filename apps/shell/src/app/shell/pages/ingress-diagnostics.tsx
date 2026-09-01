"use client";

import { useCallback, useEffect, useState } from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isAuthRequiredRedirectError } from "../core-api";
import { publishesThroughCloudflareApi } from "../ingress";
import { useShellActions, useShellState } from "../shell-context";
import type { CloudflareDiagnostics, CloudflareDiagnosticState } from "../types";
import { InlineError } from "../ui";

// What each drift verdict means and what to do about it. "ok" is filtered out before rendering, but it is
// listed so the map stays total: a state Core adds later must fail the build here rather than render as a
// blank line next to a hostname.
const DIAGNOSTIC_TEXT: Record<CloudflareDiagnosticState, string> = {
  ok: "",
  app_missing: "the app is gone, so this address is an orphan — unpublish it or remove it in Cloudflare",
  endpoint_missing: "the app no longer serves that endpoint, so the address fronts nothing — unpublish it",
  route_missing: "the tunnel has no route for it, so the address resolves to nothing — publish it again",
  route_stale: "its tunnel route points at a local port the app no longer uses — publish it again",
  dns_missing: "its DNS record is gone — publish it again to recreate it",
  dns_foreign: "its DNS record points somewhere other than this tunnel — something else answers for it",
  not_configured: "it has no address configured",
  external: "it is served from outside this zone",
  unknown: "it could not be checked just now",
};

// Core's own address gets its own vocabulary. The remedy differs from an app's in one way: under the API
// provider Hosty can publish Core itself, so a verdict on a hostname it published ends in "publish it
// again" — and only a hand-made one ends in something the operator does outside Hosty.
const CORE_TEXT: Partial<Record<CloudflareDiagnosticState, string>> = {
  not_configured:
    "Core answers on loopback only, so invitation links and the native client cannot reach this host from anywhere else.",
  route_missing: "This tunnel has no route for it, so the address resolves to nothing.",
  route_stale: "Its tunnel route points at a local port Core no longer listens on.",
  dns_missing: "It has no DNS record on this zone, so the address does not resolve.",
  dns_foreign: "Its DNS record points somewhere other than this tunnel — something else answers for it.",
  external: "It is served from outside the connected zone, so this tunnel has nothing to say about it.",
  unknown: "It could not be checked just now.",
};

// Whether what Hosty published still matches what Cloudflare serves, and which public endpoints have no
// address at all. Read-only and on demand: nothing here reconciles, because a background writer would
// fight the operator's own dashboard changes.
export function IngressDiagnostics() {
  const { coreOrigin, sendCsrfJson } = useShellActions();
  const { state } = useShellState();
  // Whether this provider can publish Core's address at all decides the whole remedy vocabulary below.
  const publishes = publishesThroughCloudflareApi(state.status?.ingressProvider);
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
  const core = diagnostics?.core ?? null;
  const publicationCount = diagnostics?.publications.length ?? 0;
  // Switching the provider away changes nothing in Cloudflare: the routes and records stay, and the
  // connector keeps serving them. An operator who reads "ingress is off" and believes the apps are no
  // longer exposed is wrong until they unpublish, so say it here rather than let them find out.
  const retained = diagnostics !== null && !publishes ? diagnostics.publications : [];

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

      {retained.length > 0 && (
        <div className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
          <p className="font-medium">
            {retained.length} address{retained.length === 1 ? " is" : "es are"} still published on Cloudflare
          </p>
          <p>
            Changing the provider does not retract them: the routes and DNS records stay, and your connector keeps
            serving them. Unpublish each endpoint, or disconnect with Remove, to take them offline.
          </p>
          <ul className="space-y-0.5">
            {retained.map((publication) => (
              <li key={`${publication.appId}:${publication.endpointKey}`} className="font-mono">
                {publication.hostname}
              </li>
            ))}
          </ul>
        </div>
      )}

      {diagnostics && (
        <div className="space-y-2 text-xs">
          {retained.length > 0 ? null : drifted.length > 0 ? (
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

          {core && core.state !== "ok" && CORE_TEXT[core.state] && (
            <div className="space-y-1 rounded-md border p-3">
              <p className="font-medium">Core&apos;s own address</p>
              <p className="text-muted-foreground">{CORE_TEXT[core.state]}</p>
              {core.state === "not_configured" ? (
                publishes ? (
                  <p className="text-muted-foreground">
                    Publish it above under a label you choose, and Hosty creates the route and the DNS record for you.
                  </p>
                ) : (
                  <p className="text-muted-foreground">
                    Publishing an app cannot do this for you — Core is not an app, and this provider cannot publish it.
                    Choose a hostname, set it under Settings → Core (or with{" "}
                    <code className="font-mono text-foreground">
                      hosty core settings set HOSTY_CORE_PUBLIC_ORIGIN https://…
                    </code>
                    ), and create the two objects below yourself.
                  </p>
                )
              ) : (
                <p className="text-muted-foreground">
                  Current origin: <span className="font-mono text-foreground">{core.origin}</span>
                </p>
              )}
              {core.managed && (
                <p className="text-muted-foreground">
                  Hosty published this address, so reapplying it from the control above repairs the route and the record.
                </p>
              )}
              {/* The by-hand recipe is for the providers that cannot publish it. Under the API provider with
                  a hostname Hosty owns, the remedy is the button above, and printing CNAME instructions next
                  to it would suggest the operator has to do both. */}
              {core.state !== "external" && !core.managed && !publishes && core.expectedDnsContent && (
                <ul className="space-y-0.5 text-muted-foreground">
                  <li>
                    Proxied <span className="text-foreground">CNAME</span>{" "}
                    <span className="font-mono text-foreground">{core.hostname ?? "core.<your-domain>"}</span> →{" "}
                    <span className="font-mono text-foreground">{core.expectedDnsContent}</span>
                  </li>
                  <li>
                    Tunnel route <span className="font-mono text-foreground">{core.hostname ?? "core.<your-domain>"}</span> →{" "}
                    <span className="font-mono text-foreground">{core.expectedService}</span>
                  </li>
                </ul>
              )}
            </div>
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
