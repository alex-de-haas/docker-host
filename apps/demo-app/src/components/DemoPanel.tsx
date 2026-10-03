"use client";
import { useDemoAuth } from "./DemoSession";
import type { DemoConfig } from "@/lib/demo-config";


// The panel resolves its own app identity through the common client transport.
export function DemoPanel({ config }: { config: DemoConfig }) {
  const { appSession, appPermissions } = useDemoAuth();

  return (
    <div className="flex h-full flex-col gap-3 p-3 text-sm">
      <div>
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{config.appId}</div>
        <h1 className="text-base font-semibold">Session</h1>
      </div>

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5">
        <Row label="Status" value={appSession.status} />
        <Row label="User" value={appSession.displayName ?? appSession.email ?? appSession.userId} />
        <Row label="Host role" value={appSession.hostRole} />
        {/* Where the credential arrived from: a panel and a sidebar page must agree, and this is
            where cookie-restricted frames demonstrate their explicit app bearer. */}
        <Row label="Token source" value={appSession.tokenSource} />
      </dl>

      <div>
        <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">App permissions</div>
        {appPermissions.permissions.length > 0 ? (
          <ul className="space-y-0.5">
            {appPermissions.permissions.map((permission) => (
              <li key={permission} className="font-mono text-xs">{permission}</li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">None — this app grants none to the current user.</p>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate font-mono text-xs">{value || "—"}</dd>
    </>
  );
}
