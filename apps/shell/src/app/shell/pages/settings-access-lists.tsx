"use client";
import { useCallback, useEffect, useState } from "react";
import { HostyEmptySlots, HostyLoader } from "../../../../../../shared/web/hosty-states";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fetchCore } from "../core-transport.js";
type Client = { clientId: string; name: string; liveGrants: number; redirectUris: string[] };
type Grant = { id: string; label: string; appId: string; expiresAt?: string; revokedAt?: string; scopes: { kind: string; targetAppId: string; actions: string[] }[] };
type Props = { coreOrigin: string; sendCsrfJson: (url: string, body: unknown, method?: string) => Promise<Response>; kind: "oauth" | "background" };
export function SettingsAccessList({ coreOrigin, sendCsrfJson, kind }: Props) {
  const [items, setItems] = useState<(Client | Grant)[]>([]), [error, setError] = useState(""), [busy, setBusy] = useState(true);
  const path = kind === "oauth" ? "/api/auth/oauth/clients" : "/api/auth/background-grants";
  const reload = useCallback(async () => {
    try { const response = await fetchCore(coreOrigin + path); const body = await response.json(); if (!response.ok) throw new Error(body.message ?? "Could not read authorizations."); setItems(kind === "oauth" ? body.clients : body); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  }, [coreOrigin, kind, path]);
  // Load remote metadata on entry; state updates follow the asynchronous request.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void reload(); }, [reload]);
  const revoke = async (id: string) => { setBusy(true); setError(""); try { await sendCsrfJson(`${coreOrigin}${path}/${encodeURIComponent(id)}`, undefined, "DELETE"); await reload(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); } };
  return <section className="flex flex-col gap-4"><header className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-medium">{kind === "oauth" ? "Registered OAuth clients" : "Background app access"}</h2><div className="flex gap-2"><Button variant="outline" disabled={busy} onClick={() => { setBusy(true); void reload(); }}>Refresh</Button>{kind === "background" && <Button asChild variant="outline"><a href={`${coreOrigin}/account/background`} target="_blank" rel="noopener noreferrer">Authorize background work</a></Button>}</div></header>
    {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    <Table><TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Access</TableHead><TableHead><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader><TableBody>
      {items.map(item => "clientId" in item ? <TableRow key={item.clientId}><TableCell>{item.name}<p className="text-xs text-muted-foreground">{item.clientId}</p></TableCell><TableCell>{item.liveGrants} active authorizations<p className="break-all text-xs text-muted-foreground">{item.redirectUris.join(", ")}</p></TableCell><TableCell><Button variant="outline" size="sm" disabled={busy} onClick={() => void revoke(item.clientId)}>Remove</Button></TableCell></TableRow>
        : <TableRow key={item.id}><TableCell>{item.label}<p className="text-xs text-muted-foreground">{item.appId}</p></TableCell><TableCell>{item.scopes.map(scope => <p key={`${scope.kind}:${scope.targetAppId}`}>{scope.targetAppId}: {scope.actions.join(", ") || scope.kind}</p>)}<p className="text-xs text-muted-foreground">{item.revokedAt ? "Revoked" : item.expiresAt ? `Expires ${new Date(item.expiresAt).toLocaleString()}` : "Until revoked"}</p></TableCell><TableCell><Button variant="outline" size="sm" disabled={busy || !!item.revokedAt} onClick={() => void revoke(item.id)}>Revoke</Button></TableCell></TableRow>)}
      {!items.length && <TableRow><TableCell colSpan={3}>{busy ? <span role="status" className="flex items-center justify-center gap-2 py-4 text-muted-foreground"><HostyLoader className="size-5" label={null} />Loading…</span> : <span className="flex flex-col items-center gap-3 py-4 text-muted-foreground">{!error && <HostyEmptySlots className="size-12" />}No authorizations.</span>}</TableCell></TableRow>}
    </TableBody></Table>
    {kind === "background" && <Button variant="outline" className="self-start" disabled={busy} onClick={async () => { setBusy(true); try { await sendCsrfJson(`${coreOrigin}${path}/revoke-all-authorizations`, {}); window.location.assign(`${coreOrigin}/login`); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setBusy(false); } }}>Revoke all my authorizations</Button>}
  </section>;
}
