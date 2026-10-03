"use client";

import { useEffect, useState } from "react";
import { Box, Search, Server } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { call, CORE_PROVIDER_ID, type Settings, type SettingsResponse, type ToolCatalog, type ToolRule } from "@/lib/api";
import { cn } from "@/lib/utils";

export function McpAccess({ data, busy, error, status, feedbackAppId, onSave }: {
  data: SettingsResponse;
  busy: boolean;
  error: string | null;
  status: string | null;
  feedbackAppId: string | null;
  onSave: (patch: Partial<Settings>, appId: string) => Promise<void>;
}) {
  const [sessions, setSessions] = useState<{ id: string; title: string | null }[]>([]);
  const [authoritySession, setAuthoritySession] = useState("");
  useEffect(() => { let live = true; void call("/sessions").then(r => r.json()).then(value => { if (live) setSessions(value.sessions ?? []); }).catch(() => {}); return () => { live = false; }; }, []);
  const [selectedId, setSelectedId] = useState(CORE_PROVIDER_ID);
  const [search, setSearch] = useState("");
  const [catalogs, setCatalogs] = useState<ToolCatalog[]>(data.toolCatalogs ?? []);
  const [toolError, setToolError] = useState("");
  const [loading, setLoading] = useState(false);
  const { settings, discovery } = data;
  const providers = [...data.providers, { appId: "hosty:development", displayName: "Development & publications", running: true, url: null }];
  const refreshTools = async () => {
    setLoading(true); setToolError("");
    try { const result = await (await call(`/settings/tools?sessionId=${encodeURIComponent(authoritySession)}`)).json() as { catalogs: ToolCatalog[]; unavailable?: string[] }; setCatalogs(result.catalogs); if (result.unavailable?.length) setToolError(`Tools unavailable for: ${result.unavailable.join(", ")}. Existing rules are preserved.`); await onSave({}, selectedId); }
    catch (cause) { setToolError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  };
  const entries = [...providers].sort((a, b) => a.appId === CORE_PROVIDER_ID ? -1 : b.appId === CORE_PROVIDER_ID ? 1 : 0);
  const query = search.trim().toLocaleLowerCase();
  const visibleEntries = entries.filter(entry =>
    `${entry.displayName} ${entry.appId}`.toLocaleLowerCase().includes(query),
  );
  const selected = visibleEntries.find(entry => entry.appId === selectedId) ?? visibleEntries[0];
  const provider = providers.find(entry => entry.appId === selected?.appId);
  const SelectedIcon = selected?.appId === CORE_PROVIDER_ID ? Server : Box;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {discovery !== "ok" && (
        <Alert><AlertDescription>
          Could not reach Core, so the app list could not be loaded. Existing access settings are unchanged.
        </AlertDescription></Alert>
      )}
      <div className="grid min-w-0 gap-6 md:grid-cols-[15rem_minmax(0,1fr)] lg:grid-cols-[19rem_minmax(0,1fr)] lg:gap-8">
        <aside aria-label="MCP applications" className="flex min-w-0 flex-col gap-4 md:border-r md:pr-6">
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-semibold">Applications</h2>
            <p className="text-sm text-muted-foreground">Offers and instruction approvals are managed in Shell.</p>
            {data.agentsSettingsUrl && <a className="text-sm underline" href={data.agentsSettingsUrl} target="_top">Open Settings → Agents</a>}
          </div>
          <InputGroup>
            <InputGroupInput
              aria-label="Search applications"
              placeholder="Search applications…"
              value={search}
              onChange={event => setSearch(event.target.value)}
            />
            <InputGroupAddon><Search aria-hidden="true" /></InputGroupAddon>
          </InputGroup>
          <nav aria-label="Select an MCP application" className="flex max-h-64 flex-col gap-1 overflow-y-auto p-1 md:max-h-[65vh]">
            {visibleEntries.map(entry => {
              const Icon = entry.appId === CORE_PROVIDER_ID ? Server : Box;
              const enabled = entry.appId === "hosty:development" || settings.mcpProviders[entry.appId] === true;
              return (
                <Button
                  key={entry.appId}
                  variant={selected?.appId === entry.appId ? "secondary" : "ghost"}
                  className="h-auto w-full justify-start gap-3 px-3 py-3"
                  aria-current={selected?.appId === entry.appId ? "true" : undefined}
                  aria-controls="mcp-application-details"
                  onClick={() => setSelectedId(entry.appId)}
                >
                  <Icon data-icon="inline-start" aria-hidden="true" />
                  <span className="flex min-w-0 flex-1 flex-col items-start gap-1 text-left">
                    <span className="w-full truncate" title={entry.displayName || entry.appId}>{entry.displayName || entry.appId}</span>
                    <span className="flex flex-wrap items-center gap-1.5 text-xs font-normal text-muted-foreground">
                      <span className={cn("size-1.5 shrink-0 rounded-full", enabled ? "bg-success" : "bg-muted-foreground")} aria-hidden="true" />
                      {enabled ? "Enabled" : "Disabled"}
                    </span>
                  </span>
                </Button>
              );
            })}
          </nav>
          {discovery === "ok" && !providers.some(entry => entry.appId !== CORE_PROVIDER_ID) && (
            <p className="text-sm text-muted-foreground">No app tools yet. Apps appear here when they expose MCP tools, switched off.</p>
          )}
        </aside>

        <section id="mcp-application-details" aria-label="Application settings" className="flex min-w-0 flex-col gap-6">
          {selected ? (
            <>
              <header className="flex min-w-0 items-center gap-4">
                <div className="flex size-12 shrink-0 items-center justify-center rounded-xl border bg-muted/40">
                  <SelectedIcon className="size-6" aria-hidden="true" />
                </div>
                <div className="flex min-w-0 flex-col gap-1">
                  <h2 className="break-words text-xl font-semibold tracking-tight">{selected.displayName || selected.appId}</h2>
                  <p className="text-sm text-muted-foreground">Assistant access to this application.</p>
                  <p className="break-all text-xs text-muted-foreground">{selected.appId}</p>
                </div>
              </header>
              <p className="text-sm text-muted-foreground">Choose how each tool runs for Claude and Codex. Run unprompted also applies to writes; Core permissions and repository checks still apply.</p>
              <label>Session with Core-approved tool access <select aria-label="Tool discovery session" value={authoritySession} onChange={event => setAuthoritySession(event.target.value)}>
                <option value="">Choose a session</option>{sessions.map(session => <option key={session.id} value={session.id}>{session.title || session.id}</option>)}
              </select></label>
              <Button variant="outline" disabled={loading || !authoritySession} onClick={() => void refreshTools()}>{loading ? "Loading tools…" : "Refresh tools"}</Button>
              {toolError && <p role="alert" className="text-destructive">{toolError}</p>}
              {(() => {
                const catalog = catalogs.find(c => c.provider === provider?.appId);
                if (!catalog) return <p className="text-sm text-muted-foreground">Refresh tools to load the available actions.</p>;
                return <div className="divide-y rounded-lg border">{catalog.tools.map(tool => {
                  const key = JSON.stringify([catalog.provider, tool.name]);
                  const rule = settings.mcpToolRules?.[key];
                  return <div key={tool.name} className="flex flex-wrap items-center justify-between gap-3 p-3">
                    <div className="min-w-0 flex-1"><p className="break-all font-medium">{tool.name}</p><p className="text-xs text-muted-foreground">{tool.description}</p>{(tool.annotations?.readOnlyHint || tool.annotations?.destructiveHint) && <p className="text-xs text-muted-foreground">App-declared: {[tool.annotations?.readOnlyHint && "Read-only", tool.annotations?.destructiveHint && "Destructive"].filter(Boolean).join(" · ")}</p>}</div>
                    <select aria-label={`Approval for ${tool.name}`} className="rounded border bg-background p-2 text-sm" disabled={busy}
                      value={rule?.identity === catalog.identity ? rule.mode : "ask"}
                      onChange={e => void onSave({ mcpToolRules: { [key]: { identity: catalog.identity, mode: e.target.value as ToolRule["mode"] } } }, catalog.provider)}>
                      <option value="ask">Ask</option><option value="run">Run unprompted</option><option value="disabled">Disabled</option>
                    </select>
                  </div>;
                })}</div>;
              })()}

              <Card className="gap-0 overflow-hidden py-0 shadow-none">
                <CardHeader className="bg-muted/40 px-5 py-4">
                  <CardTitle>Application instructions</CardTitle>
                  <CardDescription>Review and approve application instructions in Hosty Shell Settings → Agents.</CardDescription>
                </CardHeader>
              </Card>
              <p role="status" className="text-sm text-muted-foreground">{feedbackAppId === selected.appId && busy ? "Saving…" : (feedbackAppId === selected.appId ? status : null) ?? "Access changes save automatically."}</p>
            </>
          ) : (
            <Empty><EmptyHeader>
              <EmptyTitle>{query ? "No matching applications" : "No applications available"}</EmptyTitle>
              <EmptyDescription>{query ? "Try another name or application ID." : "Applications appear here when Core discovers their MCP interface."}</EmptyDescription>
            </EmptyHeader></Empty>
          )}
        </section>
      </div>
    </div>
  );
}
