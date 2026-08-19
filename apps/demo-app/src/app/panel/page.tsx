import { headers } from "next/headers";
import { getDemoAuthSnapshot } from "@/lib/host-auth";
import { getDemoConfig } from "@/lib/demo-config";

export const dynamic = "force-dynamic";

// The app's `ui.panels` surface: a tool docked in Shell's right rail, beside whatever the operator
// is looking at rather than over it.
//
// Deliberately narrow and chrome-free — a panel is a column, not a page, so it carries no
// navigation and no page header. What it shows is the session itself, because that is the property
// a placed surface has to get right: Shell mints a launch code and the frame lands with a real
// Hosty app session, exactly as a sidebar page does. A panel showing "not present" here would mean
// the embedding is broken, which is precisely what this surface exists to demonstrate.
export default async function PanelPage() {
  const config = getDemoConfig();
  const { appSession, appPermissions } = await getDemoAuthSnapshot(await headers());

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
            where they would visibly stop agreeing if the embedder ever skipped the launch code. */}
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
