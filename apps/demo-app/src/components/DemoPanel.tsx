"use client";
import { useDemoAuth } from "./DemoSession";
import type { DemoConfig } from "@/lib/demo-config";
import { useEffect } from "react";
import { StateBadge } from "./DemoAppUi";
import { Textarea } from "./ui/textarea";
import { ui } from "@hosty-sdk/app/ui";


// The panel resolves its own app identity through the common client transport.
export function DemoPanel({ config }: { config: DemoConfig }) {
  const { appSession, appPermissions } = useDemoAuth();
  useEffect(() => { ui.reportSurfaceState({ route: window.location.pathname + window.location.search + window.location.hash, state: "ready" }); }, []);

  return (
    <div className="flex h-full flex-col gap-3 p-3 text-sm">
      <div>
        <div className="text-xs text-muted-foreground">{config.appId}</div>
        <h1 className="text-base font-semibold">Session</h1>
      </div>

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5">
        <Row label="Status" value={<StateBadge tone={appSession.status === "active" ? "success" : "warning"}>{appSession.status}</StateBadge>} />
        <Row label="User" value={appSession.displayName ?? appSession.email ?? appSession.userId} />
        <Row label="Host role" value={appSession.hostRole} />
        {/* Where the credential arrived from: a panel and a sidebar page must agree, and this is
            where cookie-restricted frames demonstrate their explicit app bearer. */}
        <Row label="Token source" value={appSession.tokenSource} />
      </dl>

      <div>
        <div className="mb-1 text-xs font-medium text-muted-foreground">App permissions</div>
        {appPermissions.permissions.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {appPermissions.permissions.map((permission) => (
              <li key={permission} className="wrap-anywhere font-mono text-xs">{permission}</li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">None — this app grants none to the current user.</p>
        )}
      </div>
      <label className="flex flex-col gap-2">Unsent tool draft<Textarea aria-label="Unsent tool draft" placeholder="Retained while switching, collapsing or moving this view" /></label>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="wrap-anywhere font-mono text-xs">{value || "—"}</dd>
    </>
  );
}
