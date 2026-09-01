"use client";

import { useState } from "react";
import {
  INGRESS_PROVIDER_CLOUDFLARE_REMOTE,
  INGRESS_PROVIDER_CLOUDFLARED,
  INGRESS_PROVIDER_NONE,
  INGRESS_PROVIDER_SETTING_KEY,
  INGRESS_SETTINGS_GROUP,
  isIngressSettingVisible,
} from "../ingress";
import type { CoreSettingsState } from "../types";
import { CloudflareConnectionCard } from "./cloudflare-connection-card";
import { CorePublicOriginCard } from "./core-public-origin-card";
import { CoreSettingsForm } from "./core-settings-form";
import { IngressDiagnostics } from "./ingress-diagnostics";

// How app endpoints reach the internet, as one exclusive choice.
//
// This tab exists because the two Cloudflare paths used to look like unrelated features: one was a value
// in a dropdown, the other a connection card in a different section. Both drive the same kind of tunnel
// and differ only in who writes the routes, and a Cloudflare tunnel is either locally or remotely
// managed — never both. Presenting them as one provider is what keeps exactly one mechanism owning an
// app's public origins.
export function SettingsIngressSection({
  settings,
  settingsError,
  onSaveSettings,
}: {
  settings: CoreSettingsState | null;
  settingsError: string | null;
  onSaveSettings: (values: Record<string, string>) => Promise<void>;
}) {
  // Tracks the form's draft so the provider explanation and the connection card follow the dropdown
  // immediately, before the operator saves. Null until the form reports its first draft, which is why
  // every read falls back to the saved value rather than to a default that would hide the wrong fields
  // on the first render.
  const [draftProvider, setDraftProvider] = useState<string | null>(null);
  const savedProvider =
    settings?.settings.find((item) => item.key === INGRESS_PROVIDER_SETTING_KEY)?.value ?? INGRESS_PROVIDER_NONE;
  const provider = draftProvider ?? savedProvider;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium">Ingress</h3>
        <p className="text-xs text-muted-foreground">
          How app endpoints reach the internet. App ports listen on loopback; ingress is the layer that accepts
          public traffic, terminates HTTPS, and routes it back to the right port. Hosty never creates a tunnel
          and never runs a connector — you do.
        </p>
      </div>

      <CoreSettingsForm
        settings={settings}
        error={settingsError}
        onSave={onSaveSettings}
        showGroupHeadings={false}
        visible={(item, draft) =>
          item.group === INGRESS_SETTINGS_GROUP &&
          isIngressSettingVisible(item.key, draft[INGRESS_PROVIDER_SETTING_KEY] ?? savedProvider)
        }
        onDraftChange={(draft) => setDraftProvider(draft[INGRESS_PROVIDER_SETTING_KEY] ?? savedProvider)}
      />

      <ProviderExplanation provider={provider} />

      {provider === INGRESS_PROVIDER_CLOUDFLARE_REMOTE && (
        <>
          <div className="border-t" />
          <CloudflareConnectionCard />
          <div className="border-t" />
          {/* Core's own address, beside the app publications that ride the same tunnel. Only under this
              provider: the other two cannot create a route or a record, and there the diagnostics below
              tell the operator what to create by hand instead. */}
          <CorePublicOriginCard />
        </>
      )}

      <div className="border-t" />
      <IngressDiagnostics />
    </div>
  );
}

// What the selected provider means in practice, in the operator's terms: who owns an app's public origin
// and what they still have to do outside Hosty.
function ProviderExplanation({ provider }: { provider: string }) {
  if (provider === INGRESS_PROVIDER_CLOUDFLARE_REMOTE) {
    return (
      <p className="text-xs text-muted-foreground">
        Connect a scoped API token below, then publish an endpoint from its app under a label you choose. Hosty
        adds the route to your remotely managed tunnel and creates one exact DNS record per published hostname,
        and leaves everything else in your Cloudflare account alone. You still run the connector.
      </p>
    );
  }

  if (provider === INGRESS_PROVIDER_CLOUDFLARED) {
    return (
      <p className="text-xs text-muted-foreground">
        Hosty renders a tunnel config from the apps that are running; you run <code>cloudflared</code> against it
        yourself. Every running app gets <code>{"{app}.{base domain}"}</code> automatically, so add one wildcard
        CNAME for the base domain once. Public origins are derived and cannot be edited per app.
      </p>
    );
  }

  return (
    <p className="text-xs text-muted-foreground">
      Ingress is off: Hosty publishes nothing new, and app ports stay on loopback. Reaching an app from outside is
      yours to arrange — your own reverse proxy, a port forward, or a LAN address — and you set each app&apos;s
      public origin by hand in its settings. Anything already published on Cloudflare stays published; the checks
      below list it.
    </p>
  );
}
