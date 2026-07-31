"use client";

import type { FormEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import { Check, Copy, KeyRound, LoaderCircle, MonitorSmartphone, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { AccessTokenView, DeviceAuthorizationRequestView } from "../types";
import { EmptyState, IconButton, InlineError } from "../ui";

// Credentials for clients that have no browser: a device console, the CLI on another machine, a
// script. Two ways in — a device approves itself here after showing a code, or a credential is created
// here and its value shown once — and one list to revoke what exists.
//
// Both produce the same thing, and it is worth being blunt about what that is: Core has no scopes, so
// the credential carries the whole role of whoever approves it. This surface says so rather than
// letting the word "token" imply something narrower.
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
  // Shown once, right after creation, and never retrievable again.
  const [issued, setIssued] = useState<{ label: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [pending, existing] = await Promise.all([
        fetch(`${coreOrigin}/api/auth/device/requests`, { credentials: "include" }),
        fetch(`${coreOrigin}/api/auth/credentials`, { credentials: "include" }),
      ]);
      if (pending.ok) {
        setRequests(((await pending.json()) as { requests?: DeviceAuthorizationRequestView[] }).requests ?? []);
      }
      if (existing.ok) {
        setCredentials(((await existing.json()) as { credentials?: AccessTokenView[] }).credentials ?? []);
      }
    } catch {
      setError("Could not reach Core.");
    }
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
      const response = await sendCsrfJson(`${coreOrigin}/api/auth/credentials`, { label });
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
          Credentials for clients that cannot open a browser — the CLI on another machine, a script, a device
          console. A credential carries the full role of whoever approves it, so approving one from an
          administrator account grants administrator access to this host until it is revoked.
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
          <Button type="submit" disabled={busy || label.trim().length === 0}>
            {busy ? <LoaderCircle className="size-4 animate-spin" /> : <Plus className="size-4" />}
            Create
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          For a client that cannot run the device flow. Pass the value to <code>hosty login --token</code>.
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
