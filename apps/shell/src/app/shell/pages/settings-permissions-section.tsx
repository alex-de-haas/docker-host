"use client";

import { useEffect, useState } from "react";
import { Boxes, RefreshCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AppIcon } from "../app-icon";
import { resolveAssetSrc } from "../app-helpers";
import { isAuthRequiredRedirectError, readCoreError, redirectToCoreLoginIfAuthRequired } from "../core-api";
import { fetchCore } from "../core-transport.js";
import type { CoreApp } from "../types";

export type PermissionOverviewEntry = {
  id: string;
  kind: "permission" | "role" | "provisioning";
  description: string;
  apps: { id: string; displayName: string; icon: string | null; iconUrl: string | null }[];
};

const kindLabels = { permission: "Permission", role: "Provider role", provisioning: "Legacy provisioning" };

export function SettingsPermissionsSection({ coreOrigin, apps }: { coreOrigin: string; apps: CoreApp[] }) {
  const [entries, setEntries] = useState<PermissionOverviewEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [refresh, setRefresh] = useState(0);
  // Re-read after the live app list reports an installation, removal or authority change.
  const authorityRevision = JSON.stringify(apps.map(app => [app.id, app.version, app.grantedCorePermissions, app.confirmedRoles]));

  useEffect(() => {
    const onFocus = () => setRefresh(value => value + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setEntries(null);
      setError(null);
      try {
        const response = await fetchCore(`${coreOrigin}/api/apps/permissions`, { credentials: "include", signal: controller.signal });
        redirectToCoreLoginIfAuthRequired(response, coreOrigin);
        if (!response.ok) throw new Error(response.status === 404
          ? "Update Core to 0.128.0 or later to view the permission overview."
          : await readCoreError(response));
        const data = await response.json() as { entries: PermissionOverviewEntry[] };
        if (!controller.signal.aborted) setEntries(data.entries);
      } catch (reason) {
        if (!controller.signal.aborted && !isAuthRequiredRedirectError(reason))
          setError(reason instanceof Error ? reason.message : "Could not load app permissions.");
      }
    }
    void load();
    return () => controller.abort();
  }, [coreOrigin, authorityRevision, refresh]);

  const search = query.trim().toLocaleLowerCase();
  const filtered = entries?.filter(entry => [entry.id, entry.description, kindLabels[entry.kind],
    ...entry.apps.flatMap(app => [app.id, app.displayName])].some(value => value.toLocaleLowerCase().includes(search)));
  const loading = entries === null && error === null;

  return <section className="flex min-w-0 flex-col gap-5" aria-labelledby="app-permissions-title">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex max-w-3xl flex-col gap-1">
        <h2 id="app-permissions-title" className="text-lg font-medium">App permissions</h2>
        <p className="text-sm text-muted-foreground">Core permissions granted to installed apps and their confirmed provider roles. Stopped apps keep their grants. Permissions also depend on the acting user’s access.</p>
        <p className="text-sm text-muted-foreground">Review or change an app’s permissions from its Permissions tab. User roles and per-assistant MCP access are managed separately.</p>
      </div>
      <Button variant="outline" disabled={loading} onClick={() => setRefresh(value => value + 1)}>
        <RefreshCw data-icon="inline-start" />Refresh
      </Button>
    </div>
    <Field className="max-w-lg">
      <FieldLabel htmlFor="permissions-search">Search permissions, roles or apps</FieldLabel>
      <Input id="permissions-search" type="search" placeholder="Name, description or app…" value={query} onChange={event => setQuery(event.target.value)} />
    </Field>
    {error && <Alert variant="destructive"><AlertTitle>Could not load app permissions</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
    {loading && <p role="status" className="text-sm text-muted-foreground">Loading app permissions…</p>}
    {entries && <>
      <p role="status" className="text-sm text-muted-foreground">{filtered?.length} of {entries.length} permissions and roles</p>
      <Table aria-label="App permissions and provider roles">
        <TableHeader><TableRow>
          <TableHead scope="col">Permission or role</TableHead>
          <TableHead scope="col">Description</TableHead>
          <TableHead scope="col">Applications</TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {filtered?.map(entry => <TableRow key={`${entry.kind}:${entry.id}`}>
            <TableCell className="align-top"><div className="flex flex-col items-start gap-2">
              <code className="text-xs">{entry.id}</code>
              <Badge variant="outline">{kindLabels[entry.kind]}</Badge>
            </div></TableCell>
            <TableCell className="min-w-60 max-w-xl whitespace-normal align-top">{entry.description}</TableCell>
            <TableCell className="min-w-48 align-top">
              {entry.apps.length ? <ul className="flex flex-col gap-2">
                {entry.apps.map(app => <li key={app.id} className="flex items-center gap-2" title={app.id}>
                  <AppIcon src={resolveAssetSrc(coreOrigin, app.iconUrl)} name={app.icon} fallback={Boxes} className="size-5" />
                  <span className="whitespace-normal break-words">{app.displayName || app.id}</span>
                </li>)}
              </ul> : <span className="text-muted-foreground">No apps</span>}
            </TableCell>
          </TableRow>)}
          {!filtered?.length && <TableRow><TableCell colSpan={3} className="h-24 text-center">{search ? "No permissions, roles or apps match your search." : "No permissions or roles are available."}</TableCell></TableRow>}
        </TableBody>
      </Table>
    </>}
  </section>;
}
