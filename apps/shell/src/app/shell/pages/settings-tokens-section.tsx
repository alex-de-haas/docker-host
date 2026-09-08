"use client";

import type { FormEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import { Check, Copy, KeyRound, LoaderCircle, Pencil, Plus, ShieldAlert, ShieldCheck, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { redirectToCoreLoginIfAuthRequired } from "../core-api";
import type { AccessTokenView, CoreApp, DeviceAuthorizationRequestView } from "../types";
import { EmptyState, IconButton, InlineError } from "../ui";

// What a credential may be limited to. "" is the credential this surface always issued — full role,
// every surface — and it stays the default: narrowing is a deliberate choice, and a form that
// quietly picked a narrow default would produce credentials that mysteriously do not work.
const FULL_ACCESS = "";

// Core's own MCP endpoint as an audience. The colon keeps it out of the app-id space — an app id
// admits only [a-z0-9._-], so no installed app can ever claim this one.
const CORE_AUDIENCE = "hosty:core";

// Form-only sentinel for "Core MCP with lifecycle control": same audience, one more scope. Never
// sent to Core — the submit handler maps it back to CORE_AUDIENCE plus the scope pair.
const CORE_CONTROL = "hosty:core+lifecycle";

// Same audience again, with updates on top. A separate option rather than a wider "control" one,
// because that is the whole reason `mcp:update` is a separate scope: an operator choosing "start and
// stop things for me" has not chosen "change which versions run". Folding it in here would have
// undone the distinction at the only place anyone actually makes the choice.
const CORE_UPDATE = "hosty:core+update";

// Credentials for clients that have no browser: a device console, a native client, a
// script. Two ways in — a device approves itself here after showing a code, or a credential is created
// here and its value shown once — and one list to revoke what exists.
//
// A credential created here is full-role by default — it can do everything its approver can — and
// this surface says so rather than letting the word "token" imply something narrower. The Access
// selector is the way to mint one that is genuinely narrower: it names a single audience and the
// scope it carries there, and Core refuses it everywhere else (scoped-access-tokens).
export function SettingsTokensSection({
  coreOrigin,
  sendCsrfJson,
}: {
  coreOrigin: string;
  sendCsrfJson: (url: string, body: unknown, method?: string) => Promise<Response>;
}) {
  const [requests, setRequests] = useState<DeviceAuthorizationRequestView[]>([]);
  const [credentials, setCredentials] = useState<AccessTokenView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState("");
  const [audience, setAudience] = useState(FULL_ACCESS);
  // Apps that can actually receive a scoped credential: only an app declaring an `mcp` interface
  // has anything to validate one against, and offering the rest would produce credentials nothing
  // accepts. Empty for an ordinary user, whose /api/apps listing is their own.
  const [mcpApps, setMcpApps] = useState<{ id: string; displayName: string }[]>([]);
  // Registered OAuth clients — who may start an authorization flow against this host. Admin-only
  // on the Core side; an ordinary user's fetch 403s and the section simply does not render.
  const [oauthClients, setOauthClients] = useState<
    { clientId: string; name: string; createdAt: string; sourceAddress: string | null; liveGrants: number }[]
  >([]);
  // Shown once, right after creation, and never retrievable again.
  const [issued, setIssued] = useState<{ label: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [canManage, setCanManage] = useState(false);
  const [editing, setEditing] = useState<AccessTokenView | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [confirmation, setConfirmation] = useState<{ title: string; description: string; url: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [pending, existing, clients] = await Promise.all([
        fetch(`${coreOrigin}/api/auth/device/requests`, { credentials: "include" }),
        fetch(`${coreOrigin}/api/auth/credentials`, { credentials: "include" }),
        fetch(`${coreOrigin}/api/auth/oauth/clients`, { credentials: "include" }),
      ]);

      // An expired session must take the operator to /login. Without this the poll below would keep
      // firing forever against a dead session, showing stale rows and never saying why.
      redirectToCoreLoginIfAuthRequired(pending, coreOrigin);
      redirectToCoreLoginIfAuthRequired(existing, coreOrigin);

      if (!pending.ok || !existing.ok) {
        // Surface the failure rather than silently leaving the last good data on screen.
        setLoadError(`Core answered ${pending.ok ? existing.status : pending.status}.`);
        return;
      }

      redirectToCoreLoginIfAuthRequired(clients, coreOrigin);
      if (!clients.ok && clients.status !== 403) throw new Error(`Client list answered ${clients.status}.`);
      setCanManage(clients.ok);
      setOauthClients(clients.ok ? ((await clients.json()) as { clients: typeof oauthClients }).clients : []);
      setRequests(((await pending.json()) as { requests?: DeviceAuthorizationRequestView[] }).requests ?? []);
      setCredentials(((await existing.json()) as { credentials?: AccessTokenView[] }).credentials ?? []);
      setLoadError(null);
    } catch {
      setLoadError("Could not reach Core.");
    }
  }, [coreOrigin]);

  // Read once rather than on the five-second poll below: the app roster changes when someone
  // installs something, not while a credential form is open.
  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${coreOrigin}/api/apps`, { credentials: "include" });
        if (!response.ok) return;
        const apps = ((await response.json()) as { apps?: CoreApp[] }).apps ?? [];
        setMcpApps(
          apps
            .filter((app) => Boolean(app.interfaces?.mcp?.length))
            .map((app) => ({ id: app.id, displayName: app.displayName })),
        );
      } catch {
        // The selector simply offers Core only. This list is a convenience, and failing to load it
        // must not break the form that issues ordinary credentials.
      }
    })();
  }, [coreOrigin]);

  // A pending code expires in ten minutes and a device is usually waiting on this screen right now, so
  // the list polls rather than making the operator reload to see the code they just triggered.
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  };

  const decide = (userCode: string, decision: "approve" | "deny") =>
    run(async () => {
      await sendCsrfJson(`${coreOrigin}/api/auth/device/requests/${decision}`, { userCode });
    });

  const create = (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      // Audience and scopes travel together or not at all; Core refuses half of a pair, so the
      // form never assembles one.
      const response = await sendCsrfJson(
        `${coreOrigin}/api/auth/credentials`,
        audience === FULL_ACCESS
          ? { label }
          : audience === CORE_CONTROL
            ? { label, audience: CORE_AUDIENCE, scopes: ["mcp:read", "mcp:lifecycle"] }
            : audience === CORE_UPDATE
              ? { label, audience: CORE_AUDIENCE, scopes: ["mcp:read", "mcp:lifecycle", "mcp:update"] }
            : { label, audience, scopes: ["mcp:read"] },
      );
      const created = (await response.json()) as { label: string; token: string };
      setIssued({ label: created.label, token: created.token });
      setLabel("");
      setCopied(false);
    });
  };

  const credentialRow = (credential: AccessTokenView) => (
    <div key={credential.id} className="space-y-2 rounded-md border p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">{credential.label ?? "Unnamed credential"}</p>
          <p className="font-mono text-xs text-muted-foreground">{credential.id}</p>
        </div>
        <div className="flex gap-1">
          {canManage ? <IconButton title={`Rename ${credential.label ?? credential.id}`} disabled={busy}
            onClick={() => { setEditing(credential); setEditLabel(credential.label ?? ""); }}><Pencil className="size-4" /></IconButton> : null}
          <IconButton title={`Revoke ${credential.label ?? credential.id}`} destructive disabled={busy}
            onClick={() => setConfirmation({
              title: "Revoke credential?",
              description: `${credential.label ?? "Unnamed"} · ${credential.id}. ${credential.audience ?? "Full access"} · ${credential.scopes?.join(" ") ?? ""}. This disconnects this credential and its refresh chain. Other credentials remain active.`,
              url: `${coreOrigin}/api/auth/credentials/${credential.id}`,
            })}><Trash2 className="size-4" /></IconButton>
        </div>
      </div>
      <p className="flex items-center gap-1 text-xs">
        {credential.audience ? <ShieldCheck className="size-3.5" /> : <ShieldAlert className="size-3.5" />}
        {credential.audience === CORE_AUDIENCE ? "Core MCP" : credential.audience ?? "Full access"}
        {credential.scopes?.length ? ` · ${credential.scopes.join(" ")}` : ""}
      </p>
      <dl className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
        <div><dt>Approved by</dt><dd>{credential.userDisplayName ?? credential.userId}</dd></div>
        <div><dt>Created</dt><dd>{formatWhen(credential.createdAt)}</dd></div>
        <div><dt>Last authenticated request</dt><dd>{formatWhen(credential.lastRequestAt)}</dd></div>
        {credential.kind === "oauth" ? <div><dt>Last refresh</dt><dd>{credential.lastRefreshAt ? formatWhen(credential.lastRefreshAt) : "Not refreshed"}</dd></div> : null}
      </dl>
    </div>
  );

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium">Access tokens</h3>
        <p className="text-xs text-muted-foreground">
          Credentials for clients that cannot open a browser — a native client, a script, a device
          console, an agent client. A credential carries the full role of whoever approves it unless it
          is limited to one audience below, so approving an unlimited one from an administrator account
          grants administrator access to this host until it is revoked.
        </p>
      </div>

      {error || loadError ? <InlineError message={error ?? loadError!} /> : null}

      {requests.length > 0 ? (
        <div className="space-y-2">
          <h4 className="text-sm font-medium">Waiting for approval</h4>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Device</TableHead>
                <TableHead>Expires in</TableHead>
                <TableHead className="w-40" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {requests.map((request) => (
                <TableRow key={request.userCode}>
                  <TableCell className="font-mono">{formatUserCode(request.userCode)}</TableCell>
                  <TableCell>{request.label ?? <span className="text-muted-foreground">unnamed</span>}</TableCell>
                  <TableCell className="text-muted-foreground">{formatSeconds(request.expiresInSeconds)}</TableCell>
                  <TableCell className="flex gap-2">
                    <Button type="button" size="sm" disabled={busy} onClick={() => void decide(request.userCode, "approve")}>
                      Approve
                    </Button>
                    <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void decide(request.userCode, "deny")}>
                      Deny
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="text-xs text-muted-foreground">
            Check the code against the one shown on the device before approving. Anyone who can reach this host
            can start a request; only approving one grants anything.
          </p>
        </div>
      ) : null}

      <form className="space-y-2" onSubmit={create}>
        <h4 className="text-sm font-medium">Create a credential</h4>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-48 flex-1 space-y-1">
            <Label htmlFor="token-label">Label</Label>
            <Input
              id="token-label"
              value={label}
              placeholder="backup script"
              onChange={(event) => setLabel(event.target.value)}
              className="w-full"
            />
          </div>
          <div className="min-w-48 flex-1 space-y-1">
            <Label htmlFor="token-audience">Access</Label>
            <select
              id="token-audience"
              value={audience}
              onChange={(event) => setAudience(event.target.value)}
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
            >
              <option value={FULL_ACCESS}>Full access — everything you can do</option>
              <option value={CORE_AUDIENCE}>Core MCP — read-only</option>
              <option value={CORE_CONTROL}>Core MCP — read + app control</option>
              <option value={CORE_UPDATE}>Core MCP — read + app control + updates</option>
              {mcpApps.map((app) => (
                <option key={app.id} value={app.id}>
                  {app.displayName} — read-only tools
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" disabled={busy || label.trim().length === 0}>
            {busy ? <LoaderCircle className="size-4 animate-spin" /> : <Plus className="size-4" />}
            Create
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          For a client that cannot run the device flow. Pass the value as an <code>Authorization: Bearer</code> header.
          {audience === FULL_ACCESS
            ? " A full-access credential can do everything you can, on every Core surface."
            : audience === CORE_CONTROL
              ? " This credential can read the fleet and also start, stop and restart apps. It is refused everywhere else."
              : audience === CORE_UPDATE
                ? " This credential can also update apps — changing which version runs, not only restarting what is installed. It is refused everywhere else."
              : " A limited credential reaches only what is selected here and is refused everywhere else, including every other app."}
        </p>
      </form>

      {issued ? (
        <div className="space-y-2 rounded-md border border-dashed p-3">
          <p className="text-sm font-medium">{issued.label}</p>
          <div className="flex gap-2">
            <Input value={issued.token} readOnly className="font-mono" />
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                void navigator.clipboard.writeText(issued.token);
                setCopied(true);
              }}
            >
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            This is the only time this value is shown. Nothing stores it in a form that can be read back — if it
            is lost, revoke this credential and create another.
          </p>
        </div>
      ) : null}

      <div className="space-y-4">
        <h4 className="text-sm font-medium">Active credentials</h4>
        {credentials.length === 0 ? <EmptyState icon={KeyRound} title="No access tokens" description="Nothing but browsers is signed in to this host." /> : null}
        {(["device", "manual"] as const).map((kind) => {
          const rows = credentials.filter((credential) => credential.kind === kind);
          return rows.length ? <section key={kind} className="space-y-2">
            <h5 className="text-sm font-medium">{kind === "device" ? "Devices" : "Manual credentials"}</h5>
            <div className="grid gap-3 lg:grid-cols-2">{rows.map(credentialRow)}</div>
          </section> : null;
        })}
        <section className="space-y-3">
          <h5 className="text-sm font-medium">OAuth connections</h5>
          {Array.from(new Set([...oauthClients.map((client) => client.clientId),
            ...credentials.filter((credential) => credential.kind === "oauth").map((credential) => credential.oauthClientId ?? `unknown:${credential.id}`)]))
            .map((clientId) => {
              const client = oauthClients.find((candidate) => candidate.clientId === clientId);
              const grants = credentials.filter((credential) => credential.kind === "oauth" &&
                (credential.oauthClientId ?? `unknown:${credential.id}`) === clientId);
              return <div key={clientId} className="space-y-3 rounded-lg border p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h6 className="text-sm font-medium">{client?.name ?? grants[0]?.oauthClientName ?? "OAuth client"}</h6>
                    <p className="break-all font-mono text-xs text-muted-foreground">{clientId}</p>
                    {client ? <p className="text-xs text-muted-foreground">Registered {formatWhen(client.createdAt)} · From {client.sourceAddress ?? "unknown"} · {client.liveGrants} live grants</p> : null}
                  </div>
                  {canManage && client ? <IconButton title={`Delete client ${client.name}`} destructive disabled={busy}
                    onClick={() => setConfirmation({ title: "Delete OAuth client?",
                      description: `${client.name} · ${client.clientId}. This blocks pending sign-ins and revokes all ${client.liveGrants} live grants for this registration: ${grants.map((grant) => `${grant.label ?? "Unnamed"} (${grant.id})`).join(", ") || "none"}. The client may need to register again before reconnecting.`,
                      url: `${coreOrigin}/api/auth/oauth/clients/${encodeURIComponent(client.clientId)}`,
                    })}><Trash2 className="size-4" /></IconButton> : null}
                </div>
                {grants.length ? <div className="grid gap-3 lg:grid-cols-2">{grants.map(credentialRow)}</div>
                  : <p className="text-xs text-muted-foreground">No live grants. A registered client may still be waiting for authorization.</p>}
              </div>;
            })}
        </section>
        <p className="text-xs text-muted-foreground">Labels are your descriptions, not verified device identities. Request activity is sampled at most once every five minutes; unknown does not mean unused. Refresh is separate from request activity. New authorization creates a separate credential; revoke the old one when you no longer need it.</p>
      </div>
      <Dialog open={editing !== null} onOpenChange={(open) => { if (!open && !busy) setEditing(null); }}>
        <DialogContent><DialogHeader><DialogTitle>Rename credential</DialogTitle>
          <DialogDescription>{editing?.id} · Changing a label does not change permissions.</DialogDescription></DialogHeader>
          {error ? <InlineError message={error} /> : null}
          <Label htmlFor="credential-label">Label</Label>
          <Input id="credential-label" value={editLabel} maxLength={120} onChange={(event) => setEditLabel(event.target.value)} placeholder="Codex — MacBook — production" />
          <DialogFooter><Button disabled={busy || !editLabel.trim()} onClick={() => void run(async () => {
            const response = await sendCsrfJson(`${coreOrigin}/api/auth/credentials/${editing!.id}/label`, { label: editLabel }, "PATCH");
            if (!response.ok) throw new Error("Could not rename credential.");
            setEditing(null);
          })}>Save label</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={confirmation !== null} onOpenChange={(open) => { if (!open && !busy) setConfirmation(null); }}>
        <DialogContent><DialogHeader><DialogTitle>{confirmation?.title}</DialogTitle>
          <DialogDescription className="break-words">{confirmation?.description}</DialogDescription></DialogHeader>
          {error ? <InlineError message={error} /> : null}
          <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setConfirmation(null)}>Cancel</Button>
            <Button variant="destructive" disabled={busy} onClick={() => void run(async () => {
              const response = await sendCsrfJson(confirmation!.url, undefined, "DELETE");
              if (!response.ok) {
                const body = await response.json().catch(() => null) as { message?: string } | null;
                throw new Error(body?.message ?? "Could not finish revocation. Retry.");
              }
              setConfirmation(null);
            })}>Confirm</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// The device shows the code in two groups; matching that here is what makes comparing them quick.
function formatUserCode(code: string) {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

function formatSeconds(seconds: number) {
  if (seconds <= 0) return "expired";
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function formatWhen(value: string | null | undefined) {
  if (!value) return "Unknown";
  const when = new Date(value);
  return Number.isNaN(when.getTime()) ? "unknown" : when.toLocaleString();
}
