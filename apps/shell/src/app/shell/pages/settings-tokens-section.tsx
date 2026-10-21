"use client";
import { useCallback, useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fetchCore } from "../core-transport.js";

type Credential = { id: string; kind: string; label?: string; audience?: string; scopes: string[]; createdAt: string; lastSeenAt: string; oauthClientName?: string; oauthClientId?: string; lastRequestAt?: string | null; lastRefreshAt?: string | null; expiresAt?: string };
export function SettingsTokensSection({ coreOrigin, sendCsrfJson, userId }: { coreOrigin: string; userId?: string;
  sendCsrfJson: (url: string, body: unknown, method?: string) => Promise<Response> }) {
  const [credentials, setCredentials] = useState<Credential[]>([]), [loading, setLoading] = useState(true);
  const [error, setError] = useState(""), [pending, setPending] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null), [label, setLabel] = useState("");
  const reload = useCallback(async () => {
    try {
      const response = await fetchCore(`${coreOrigin}/api/auth/credentials${userId ? `?userId=${encodeURIComponent(userId)}` : ""}`);
      const result = await response.json() as { credentials?: Credential[]; message?: string };
      if (!response.ok) throw new Error(result.message ?? "Could not load tokens and devices.");
      setCredentials(result.credentials ?? []); setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  }, [coreOrigin, userId]);
  // Load remote metadata on entry; state updates follow the asynchronous request.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void reload(); }, [reload]);
  const revoke = async (id: string) => {
    setPending(id); setError("");
    try { await sendCsrfJson(`${coreOrigin}/api/auth/credentials/${encodeURIComponent(id)}`, undefined, "DELETE"); await reload(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(null); }
  };
  const rename = async (id: string) => {
    setPending(id); setError("");
    try { await sendCsrfJson(`${coreOrigin}/api/auth/credentials/${encodeURIComponent(id)}/label`, { label }, "PATCH"); setEditing(null); await reload(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(null); }
  };
  return <section className="flex flex-col gap-4" aria-label="Tokens and devices">
    <header className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-medium">Tokens & devices</h2><div className="flex flex-wrap gap-2">
      <Button variant="outline" disabled={loading || Boolean(pending)} onClick={() => { setLoading(true); void reload(); }}>Refresh</Button>
      {!userId && <><Button variant="outline" asChild><a href={`${coreOrigin}/account/device`} target="_blank" rel="noopener noreferrer">Connect device</a></Button>
      <Button asChild><a href={`${coreOrigin}/account/tokens`} target="_blank" rel="noopener noreferrer">Create token</a></Button></>}
    </div></header>
    {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    <Table><TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Access</TableHead><TableHead>Last used</TableHead><TableHead><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader>
      <TableBody>{credentials.map(credential => <TableRow key={credential.id}><TableCell>{editing === credential.id ? <div className="flex gap-2"><Input aria-label="Credential name" value={label} onChange={event => setLabel(event.target.value)} /><Button size="sm" disabled={Boolean(pending) || !label.trim()} onClick={() => void rename(credential.id)}>Save name</Button><Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button></div> : <p>{credential.label || credential.oauthClientName || (credential.kind === "browser" ? "Browser session" : credential.kind)}</p>}<p className="text-xs text-muted-foreground">{credential.id}</p>{credential.oauthClientId && <p className="text-xs text-muted-foreground">{credential.oauthClientName} · {credential.oauthClientId}</p>}</TableCell>
        <TableCell><p>{credential.audience || "Your host role"}</p><p className="text-xs text-muted-foreground">{credential.scopes.join(", ")}</p></TableCell>
        <TableCell>{credential.lastRequestAt ? new Date(credential.lastRequestAt).toLocaleString() : "No recorded request"}{credential.lastRefreshAt && <p className="text-xs text-muted-foreground">Refreshed {new Date(credential.lastRefreshAt).toLocaleString()}</p>}{credential.expiresAt && <p className="text-xs text-muted-foreground">Expires {new Date(credential.expiresAt).toLocaleString()}</p>}</TableCell><TableCell className="text-right"><Button className="mr-2" variant="ghost" size="sm" disabled={Boolean(pending)} onClick={() => { setEditing(credential.id); setLabel(credential.label || credential.oauthClientName || ""); }}>Rename</Button><Button variant="outline" size="sm" disabled={Boolean(pending)} onClick={() => void revoke(credential.id)}>{pending === credential.id ? "Revoking…" : "Revoke"}</Button></TableCell></TableRow>)}
      {!credentials.length && <TableRow><TableCell colSpan={4}>{loading ? "Loading…" : "No active tokens or devices."}</TableCell></TableRow>}</TableBody></Table>
  </section>;
}
