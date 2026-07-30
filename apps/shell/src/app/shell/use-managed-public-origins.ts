"use client";

import { useEffect, useState } from "react";
import { isAuthRequiredRedirectError } from "./core-api";
import { derivesPublicOrigins, publishesThroughCloudflareApi } from "./ingress";
import { buildPublicOriginSettingKey } from "./settings";
import { useShellActions, useShellState } from "./shell-context";
import type { CloudflareAppPublications, CoreApp } from "./types";

// Why an app's public origin is not the operator's to type right now, per setting key. Core is the
// authority — `configure` refuses a managed write with `public_origin_managed` — and this is the same
// rule applied to rendering, so the field explains itself instead of failing on save.
export type ManagedPublicOriginReason = "derived" | "published";

// Under the local-config provider Core derives every public origin from the base domain on each start,
// so all of them are managed and no request is needed. Under the API provider only the endpoints with a
// publication are: fronting one endpoint with your own proxy while publishing another is legitimate, and
// only Core knows which is which, so that case reads this app's publications.
export function useManagedPublicOrigins(app: CoreApp, enabled: boolean) {
  const { state } = useShellState();
  const { coreOrigin, sendCsrfJson } = useShellActions();
  const provider = state.status?.ingressProvider;
  // Carries the app it was loaded for, so a switch to another app (or another provider) falls back to
  // "nothing managed" while the new read is in flight instead of showing the previous app's answer.
  const [loaded, setLoaded] = useState<{ appId: string; keys: string[] } | null>(null);

  const readsPublications = enabled && publishesThroughCloudflareApi(provider);
  useEffect(() => {
    if (!readsPublications) {
      return;
    }

    let cancelled = false;
    const load = async () => {
      try {
        const response = await sendCsrfJson(
          `${coreOrigin}/api/apps/${encodeURIComponent(app.id)}/public-origins`,
          undefined,
          "GET",
        );
        const body = (await response.json()) as CloudflareAppPublications;
        if (!cancelled) {
          setLoaded({
            appId: app.id,
            keys: (body?.publications ?? []).map((entry) => buildPublicOriginSettingKey(entry.endpointKey)),
          });
        }
      } catch (error) {
        // A failed read must not lock the operator out of a field they may well own. Core still refuses a
        // genuinely managed write, so the worst case is an error on save rather than a silent divergence.
        if (!cancelled && !isAuthRequiredRedirectError(error)) {
          setLoaded({ appId: app.id, keys: [] });
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [readsPublications, app.id, coreOrigin, sendCsrfJson]);

  const published = readsPublications && loaded?.appId === app.id ? loaded.keys : [];

  if (!enabled) {
    return new Map<string, ManagedPublicOriginReason>();
  }

  if (derivesPublicOrigins(provider)) {
    return new Map<string, ManagedPublicOriginReason>(
      (app.endpoints ?? [])
        .filter((endpoint) => endpoint.public)
        .map((endpoint) => [buildPublicOriginSettingKey(endpoint.key), "derived"]),
    );
  }

  return new Map<string, ManagedPublicOriginReason>(published.map((key) => [key, "published"]));
}
