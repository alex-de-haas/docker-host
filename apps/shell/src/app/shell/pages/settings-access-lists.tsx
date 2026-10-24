"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { MoreHorizontal, RefreshCw } from "lucide-react";
import { HostyEmptySlots, HostyLoader } from "../../../../../../shared/web/hosty-states";
import { Frame, FrameFooter, FrameHeader, FramePanel } from "@/components/reui/frame";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fetchCore } from "../core-transport.js";

type Client = { clientId: string; name: string; liveGrants: number; redirectUris: string[] };
type Grant = { id: string; label: string; appId: string; expiresAt?: string; revokedAt?: string; scopes: { id: string; kind: string; targetAppId: string; actions: string[]; providerKind?: string; key?: string }[] };
type Props = { coreOrigin: string; actorId?: string | null; kind: "oauth" | "background";
  sendCsrfJson: (url: string, body: unknown, method?: string, signal?: AbortSignal) => Promise<Response> };

export function SettingsAccessList(props: Props) {
  return <AccessList key={JSON.stringify([props.coreOrigin, props.actorId ?? null, props.kind])} {...props} />;
}

function AccessList({ coreOrigin, sendCsrfJson, kind }: Props) {
  const [items, setItems] = useState<(Client | Grant)[]>([]), [search, setSearch] = useState("");
  const [loadError, setLoadError] = useState(""), [actionError, setActionError] = useState("");
  const [loading, setLoading] = useState(true), [pending, setPending] = useState(false);
  const [observedAt, setObservedAt] = useState(0);
  const read = useRef<AbortController | null>(null), lifetime = useRef<AbortController | null>(null), mutation = useRef(false);
  const searchId = useId();
  const path = kind === "oauth" ? "/api/auth/oauth/clients" : "/api/auth/background-grants";
  const title = kind === "oauth" ? "Registered OAuth clients" : "Background app access";
  const reload = useCallback(async () => {
    read.current?.abort();
    const controller = new AbortController(); read.current = controller;
    try {
      const response = await fetchCore(coreOrigin + path, { signal: controller.signal });
      const body = await response.json(); controller.signal.throwIfAborted();
      if (!response.ok) throw new Error(body.message ?? "Could not read authorizations.");
      setItems(kind === "oauth" ? body.clients : body); setObservedAt(Date.now()); setLoadError("");
    } catch (cause) {
      if (!controller.signal.aborted) setLoadError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }, [coreOrigin, kind, path]);
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    // Entry reads settle asynchronously and are scoped to the current actor and Core.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
    return () => { controller.abort(); read.current?.abort(); };
  }, [reload]);
  const revoke = async (id: string) => {
    if (mutation.current) return;
    mutation.current = true; setPending(true); setActionError("");
    const signal = lifetime.current!.signal;
    try {
      const response = await sendCsrfJson(`${coreOrigin}${path}/${encodeURIComponent(id)}`, undefined, "DELETE", signal);
      signal.throwIfAborted();
      if (!response.ok) throw new Error("Core did not confirm this revocation.");
      await reload();
    } catch (cause) {
      if (!signal.aborted) setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally { mutation.current = false; if (!signal.aborted) setPending(false); }
  };
  const query = search.trim().toLocaleLowerCase();
  const matching = items.filter(item => !query || ("clientId" in item
    ? [item.name, item.clientId, ...item.redirectUris]
    : [item.label, item.appId, ...item.scopes.flatMap(scope => [scope.kind, scope.targetAppId, scope.providerKind, scope.key, ...scope.actions])])
    .some(value => value?.toLocaleLowerCase().includes(query)));
  const busy = loading || pending;
  return <section className="flex min-w-0 flex-col gap-4" aria-label={title}>
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex flex-col gap-1"><h2 className="text-lg font-medium">{title}</h2><p className="text-sm text-muted-foreground">{kind === "background" ? "Access you granted to apps for work that continues after you sign out." : "OAuth clients registered with this host and their active authorizations."}</p></div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={busy} onClick={() => { setLoading(true); void reload(); }}><RefreshCw data-icon="inline-start" />Refresh</Button>
        {kind === "background" && <Button asChild variant="outline"><a href={`${coreOrigin}/account/background`} target="_blank" rel="noopener noreferrer">Authorize background work</a></Button>}
      </div>
    </header>
    {loadError && <Alert variant="destructive"><AlertDescription>{loadError}{items.length > 0 && " Previously loaded authorizations are shown."}</AlertDescription></Alert>}
    {actionError && <Alert variant="destructive"><AlertDescription>{actionError}</AlertDescription></Alert>}
    {(loading || pending) && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><HostyLoader className="size-5" label={null} />{pending ? "Reviewing revocation in Core…" : "Loading authorizations…"}</p>}
    <Frame spacing="xs" className="min-w-0">
      <FrameHeader className="gap-3 py-3">
        <Field><FieldLabel className="sr-only" htmlFor={searchId}>{`Search ${title.toLocaleLowerCase()}`}</FieldLabel><Input id={searchId} type="search" placeholder={`Search ${title.toLocaleLowerCase()}…`} value={search} onChange={event => setSearch(event.target.value)} /></Field>
        <p className="text-xs text-muted-foreground">{kind === "background" ? "Only your background authorizations are listed. Revoking one keeps your other access." : "Removing a client revokes its authorizations."}</p>
      </FrameHeader>
      <FramePanel className="min-w-0 p-0">
        <Table aria-label={title} aria-busy={busy} className="min-w-[560px] table-fixed">
          <TableCaption className="sr-only">{title}. Access changes are reviewed in Core.</TableCaption>
          <TableHeader><TableRow><TableHead scope="col" className="w-[30%]">Name</TableHead><TableHead scope="col">Access</TableHead>{kind === "background" && <TableHead scope="col" className="w-[24%]">Status</TableHead>}<TableHead scope="col" className="w-12"><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader>
          <TableBody>{matching.map(item => {
            const client = "clientId" in item;
            const id = client ? item.clientId : item.id, name = client ? item.name : item.label;
            return <TableRow key={id} className="h-12">
              <TableCell className="whitespace-normal break-words"><div className="flex flex-col gap-1"><span className="font-medium">{name}</span><span className="break-all text-xs text-muted-foreground">{client ? item.clientId : item.appId}</span></div></TableCell>
              <TableCell className="whitespace-normal break-words"><div className="flex flex-col gap-1">{client ? <><span>{item.liveGrants} active authorizations</span><span className="break-all text-xs text-muted-foreground">{item.redirectUris.join(", ")}</span></> : item.scopes.map((scope, index) => <div key={scope.id ?? index} className="flex flex-col gap-1"><span className="break-all">{scope.targetAppId || scope.kind}</span><span className="break-all text-xs text-muted-foreground">{[scope.providerKind, scope.key, scope.actions.join(", ") || scope.kind].filter(Boolean).join(" · ")}</span></div>)}</div></TableCell>
              {!client && <TableCell className="whitespace-normal"><div className="flex flex-col items-start gap-1"><Badge variant="secondary">{item.revokedAt ? "Revoked" : item.expiresAt && Date.parse(item.expiresAt) <= observedAt ? "Expired" : "Not revoked"}</Badge><span className="text-xs text-muted-foreground">{item.expiresAt ? <>Expires <time dateTime={item.expiresAt}>{new Date(item.expiresAt).toLocaleString()}</time></> : "Until revoked"}</span></div></TableCell>}
              <TableCell><DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" disabled={busy} aria-label={`Actions for ${name}`}><MoreHorizontal /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuGroup><DropdownMenuItem variant="destructive" disabled={!client && !!item.revokedAt} onSelect={() => void revoke(id)}>{client ? "Remove client…" : "Revoke access…"}</DropdownMenuItem></DropdownMenuGroup></DropdownMenuContent></DropdownMenu></TableCell>
            </TableRow>;
          })}{!matching.length && <TableRow><TableCell colSpan={kind === "background" ? 4 : 3} className="py-8 text-center whitespace-normal text-muted-foreground">{loading ? "Loading authorizations…" : loadError ? "Authorizations could not be loaded." : <div className="flex flex-col items-center gap-3"><HostyEmptySlots className="size-12" />{items.length ? <>No authorizations match this search.<Button variant="outline" size="sm" onClick={() => setSearch("")}>Clear search</Button></> : "No authorizations."}</div>}</TableCell></TableRow>}</TableBody>
        </Table>
      </FramePanel>
      <FrameFooter className="py-3"><p aria-live="polite" className="text-xs tabular-nums text-muted-foreground">{loading ? "Loading…" : loadError && !items.length ? "Unavailable" : `${matching.length} of ${items.length} authorizations`}</p></FrameFooter>
    </Frame>
  </section>;
}
