"use client";

import type { FormEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import { Check, Copy, KeyRound, LoaderCircle, MonitorSmartphone, Plus, ShieldAlert, ShieldCheck, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

  const refresh = useCallback(async () => {
    try {
      const [pending, existing] = await Promise.all([
        fetch(`${coreOrigin}/api/auth/device/requests`, { credentials: "include" }),
        fetch(`${coreOrigin}/api/auth/credentials`, { credentials: "include" }),
      ]);

      // An expired session must take the operator to /login. Without this the poll below would keep
      // firing forever against a dead session, showing stale rows and never saying why.
      redirectToCoreLoginIfAuthRequired(pending, coreOrigin);
      redirectToCoreLoginIfAuthRequired(existing, coreOrigin);

      if (!pending.ok || !existing.ok) {
        // Surface the failure rather than silently leaving the last good data on screen.
        setError(`Core answered ${pending.ok ? existing.status : pending.status}.`);
        return;
      }

      setRequests(((await pending.json()) as { requests?: DeviceAuthorizationRequestView[] }).requests ?? []);
      setCredentials(((await existing.json()) as { credentials?: AccessTokenView[] }).credentials ?? []);
      setError(null);
    } catch {
      setError("Could not reach Core.");
    }
  }, [coreOrigin]);

  // Read once, like the app roster: registrations change when an operator connects a client, not
  // while this page sits open.
  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${coreOrigin}/api/auth/oauth/clients`, { credentials: "include" });
        if (!response.ok) return;
        setOauthClients(((await response.json()) as { clients?: typeof oauthClients }).clients ?? []);
      } catch {
        // The list is informational; failing to load it must not break the credential form.
      }
    })();
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

  const revoke = (id: string) =>
    run(async () => {
      await sendCsrfJson(`${coreOrigin}/api/auth/credentials/${id}`, undefined, "DELETE");
    });

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

      {error ? <InlineError message={error} /> : null}

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
        <div className="flex items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="token-label">Label</Label>
            <Input
              id="token-label"
              value={label}
              placeholder="backup script"
              onChange={(event) => setLabel(event.target.value)}
              className="w-64"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="token-audience">Access</Label>
            <select
              id="token-audience"
              value={audience}
              onChange={(event) => setAudience(event.target.value)}
              className="h-9 w-72 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
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

      <div className="space-y-2">
        <h4 className="text-sm font-medium">Active credentials</h4>
        {credentials.length === 0 ? (
          <EmptyState icon={KeyRound} title="No access tokens" description="Nothing but browsers is signed in to this host." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Label</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Access</TableHead>
                <TableHead>Approved by</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {credentials.map((credential) => (
                <TableRow key={credential.id}>
                  <TableCell>{credential.label ?? <span className="text-muted-foreground">unnamed</span>}</TableCell>
                  <TableCell className="text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      {credential.kind === "device" ? <MonitorSmartphone className="size-3.5" /> : <KeyRound className="size-3.5" />}
                      {credential.kind === "device" ? "Device" : "Created here"}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {credential.audience ? (
                      <span className="inline-flex items-center gap-1">
                        <ShieldCheck className="size-3.5" />
                        {credential.audience === CORE_AUDIENCE ? "Core MCP" : credential.audience}
                        {credential.scopes?.length ? ` · ${credential.scopes.join(" ")}` : null}
                      </span>
                    ) : (
                      // Said in words, not left as a blank cell: "no audience" is the widest
                      // credential here, and a reader should not have to infer that from an absence.
                      <span className="inline-flex items-center gap-1">
                        <ShieldAlert className="size-3.5" />
                        Full access
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{credential.userDisplayName ?? credential.userId}</TableCell>
                  <TableCell className="text-muted-foreground">{formatWhen(credential.lastSeenAt)}</TableCell>
                  <TableCell>
                    <IconButton title="Revoke" destructive disabled={busy} onClick={() => void revoke(credential.id)}>
                      <Trash2 className="size-4" />
                    </IconButton>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <p className="text-xs text-muted-foreground">
          Revoking takes effect at once, including any live event stream the credential is holding open. This is
          how a lost device is dealt with.
        </p>
      </div>

      {oauthClients.length > 0 ? (
        <div className="space-y-2">
          <h4 className="text-sm font-medium">OAuth clients</h4>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Client</TableHead>
                <TableHead>Registered</TableHead>
                <TableHead>From</TableHead>
                <TableHead>Live grants</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {oauthClients.map((client) => (
                <TableRow key={client.clientId}>
                  <TableCell>{client.name}</TableCell>
                  <TableCell className="text-muted-foreground">{formatWhen(client.createdAt)}</TableCell>
                  <TableCell className="text-muted-foreground">{client.sourceAddress ?? "unknown"}</TableCell>
                  <TableCell className="text-muted-foreground">{client.liveGrants}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="text-xs text-muted-foreground">
            Who may start an OAuth sign-in against this host. What each one was actually granted appears
            above as an oauth credential, revocable like any other. Registration itself is controlled by
            the &quot;{"OAuth client registration"}&quot; switch in Core settings.
          </p>
        </div>
      ) : null}
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

function formatWhen(value: string) {
  const when = new Date(value);
  return Number.isNaN(when.getTime()) ? "unknown" : when.toLocaleString();
}
